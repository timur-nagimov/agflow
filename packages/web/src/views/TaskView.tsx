import {
  type Attempt,
  liveChatOnly,
  type Runner,
  runnerForbiddenPaths,
  type SubmissionRecord,
  type Task,
  type TaskNote,
} from '@agflow/core';
import { type FormEvent, useEffect, useState } from 'react';
import { type HandbackSource, api } from '../api';
import {
  ATTEMPT_STATUS_LABELS,
  END_REASON_LABELS,
  FAILURE_CLASS_LABELS,
  type NoteGroup,
  attemptLabel,
  attemptTone,
  canHandBack,
  currentAttempt,
  handbackSource,
  holderOf,
  newestLog,
  nextTryText,
  noteGroups,
  phaseLabel,
  submissionOutcome,
  takeoverState,
  wipText,
} from '../attempts';
import {
  AttemptLink,
  AttemptLog,
  CommandBlock,
  Composer,
  ErrorBox,
  EventList,
  Fact,
  Linked,
  Loading,
  MessageList,
  RepoRef,
  Section,
  StatusChip,
  TaskLink,
  When,
} from '../components';
import {
  BLOCKED_TITLES,
  NOTE_LABELS,
  NOTE_TONES,
  TASK_ACTIONS,
  type TaskHolder,
  type TaskAction,
  VENDOR_NAMES,
  actionBody,
  actionHint,
  actionsFor,
  concernsAttempt,
  concernsTask,
  duration,
  evidenceText,
  threadTarget,
  toneOf,
  who,
} from '../format';
import { useAction, useData, useNow } from '../hooks';
import { useHub } from '../hub';
import { RunnerActions } from '../RunnerActions';
import { routeHref } from '../route';

/** The notes that stay in the Notes list; handoffs, restatements and late work sit side by side instead. */
const LISTED_NOTES = new Set<TaskNote['kind']>(['progress', 'release']);

export function TaskView({ id }: { id: string }) {
  const { status, runners } = useHub();
  // With 6.17's subjects, the events of the task's attempts name the task too.
  const detail = useData(() => api.task(id), [id], { relevant: (event) => concernsTask(event, id) });
  if (!detail.data) return detail.error ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : <Loading />;
  const { task, notes, events, messages, attempts, submissions } = detail.data;
  const repo = status.data?.project.repo;
  const goalVersion = status.data?.goalVersion;
  const thread = threadTarget(task);
  const current = currentAttempt(task, attempts);
  const holder = holderOf(task, attempts);
  const runner = runners.data?.runners.find((entry) => entry.id === current?.runnerId) ?? null;
  const groups = noteGroups(notes, attempts);

  return (
    <div className="page">
      <a className="back" href={routeHref({ view: 'board' })}>
        ← Board
      </a>
      <header className="task-head">
        <div className="task-head-top">
          <span className="task-id big">{task.id}</span>
          <StatusChip status={task.status} blockedKind={task.blockedKind} />
          {liveChatOnly(task) ? <LiveChatOnly task={task} /> : null}
        </div>
        <h1 className="page-title">{task.title}</h1>
        <dl className="facts">
          <Fact label="Agent">{task.assignee ?? '—'}</Fact>
          <Fact label="Priority">P{task.priority}</Fact>
          <Fact label="Kind">{task.kind}</Fact>
          <Fact label="Branch">{task.branch ? <RepoRef repo={repo} kind="branch" refName={task.branch} /> : '—'}</Fact>
          <Fact label="Goal">
            v{task.goalVersion}
            {goalVersion !== undefined && task.goalVersion < goalVersion ? (
              <span className="warn-text"> · goal is now v{goalVersion}</span>
            ) : null}
          </Fact>
          {task.leaseExpiresAt ? (
            <Fact label="Lease">
              <LeaseLeft until={task.leaseExpiresAt} />
            </Fact>
          ) : null}
          {task.currentAttempt ? (
            <Fact label="Current attempt">
              <AttemptLink id={task.currentAttempt} />
              {current ? ` · ${phaseLabel(current)}` : null}
            </Fact>
          ) : null}
          <Fact label="Work position">
            {task.workRef ? (
              <>
                <code>{task.workRef}</code>
                {task.workSha ? (
                  <>
                    {' at '}
                    <RepoRef repo={repo} kind="commit" refName={task.workSha} />
                  </>
                ) : null}
              </>
            ) : (
              // The hub starts from the configured main branch, whose name the web is not told.
              'The main branch'
            )}
          </Fact>
          <NextTry task={task} />
          {task.attemptCount > 0 ? <Fact label="Attempts">{task.attemptCount}</Fact> : null}
          <Fact label="Created">
            {who(task.createdBy)} · <When ts={task.createdAt} />
          </Fact>
        </dl>
      </header>
      <Attention task={task} />
      {takeoverState(task, current).kind !== 'none' ? (
        <TakeoverPanel
          task={task}
          attempt={current}
          runner={runner}
          runnersLoaded={runners.data !== undefined}
          onDone={detail.reload}
        />
      ) : null}
      <Actions
        key={task.status}
        task={task}
        holder={holder}
        attempt={current}
        runner={runner}
        onDone={detail.reload}
      />
      {attempts.length > 0 ? <Attempts attempts={attempts} current={task.currentAttempt} /> : null}
      {groups.length > 0 ? <Handoffs groups={groups} /> : null}
      <div className="grid-2">
        <div className="stack">
          <Contract task={task} />
          {task.submission ? <Submission task={task} repo={repo} /> : null}
          {submissions.length > 0 ? <Submissions submissions={submissions} /> : null}
          <Notes notes={notes.filter((note) => LISTED_NOTES.has(note.kind))} />
        </div>
        <div className="stack">
          {task.currentAttempt ? <CurrentLog attemptId={task.currentAttempt} /> : null}
          <Section title="Thread">
            <MessageList messages={[...messages].reverse()} />
            <Composer to={thread.to} taskId={thread.taskId} placeholder={thread.placeholder} />
          </Section>
          <Section title="History">
            <EventList events={[...events].reverse()} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function LeaseLeft({ until }: { until: number }) {
  const now = useNow();
  return <>{until > now ? `${duration(until - now)} left` : 'expired'}</>;
}

/** An infra ending's backoff (design 6.9): no new attempt of a ready task before this time. */
function NextTry({ task }: { task: Task }) {
  const text = nextTryText(task, useNow());
  return text ? <Fact label="Next try">{text}</Fact> : null;
}

/** Every attempt of the task in the order they ran, each linking its attempt page (design 11). */
function Attempts({ attempts, current }: { attempts: Attempt[]; current: string | null }) {
  // The hub lists them newest first.
  const ordered = [...attempts].reverse();
  return (
    <section className="card table-card attempts-card">
      <header className="card-head">
        <h2>Attempts</h2>
      </header>
      <table className="attempts-table">
        <thead>
          <tr>
            <th>Attempt</th>
            <th>Agent</th>
            <th>Vendor and model</th>
            <th>Runner</th>
            <th>Status</th>
            <th>End reason</th>
            <th>Class</th>
            <th>Work in progress</th>
            <th>Started</th>
            <th>Ended</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((attempt) => (
            <tr key={attempt.id} className={attempt.id === current ? 'attempt-current' : undefined}>
              <td className="attempt-number">
                <span className="attempt-name">
                  <span className={`lamp tone-${attemptTone(attempt)}`} />
                  <AttemptLink id={attempt.id} />
                </span>
              </td>
              <td className="attempt-agent mono">{attempt.agentId}</td>
              <td className="attempt-vendor">
                {VENDOR_NAMES[attempt.vendor]}
                {attempt.model ? <span className="mono muted"> · {attempt.model}</span> : null}
              </td>
              <td className="attempt-runner">{attempt.runnerId ?? <span className="muted">Live chat</span>}</td>
              <td className="attempt-status">{ATTEMPT_STATUS_LABELS[attempt.status]}</td>
              <td className="attempt-end">{attempt.endReason ? END_REASON_LABELS[attempt.endReason] : '—'}</td>
              <td className="attempt-class">{attempt.failureClass ? FAILURE_CLASS_LABELS[attempt.failureClass] : '—'}</td>
              <td className="attempt-wip mono">{wipText(attempt) ?? '—'}</td>
              <td className="attempt-started">
                <When ts={attempt.startedAt} clock />
              </td>
              <td className="attempt-ended">{attempt.endedAt ? <When ts={attempt.endedAt} clock /> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The newest entries of the current attempt's log. Logging sends no event, so it also reloads on a timer. */
function CurrentLog({ attemptId }: { attemptId: string }) {
  const detail = useData(() => api.attempt(attemptId), [attemptId], {
    relevant: (event) => concernsAttempt(event, attemptId),
    refreshMs: 30_000,
  });
  return (
    <Section
      title="Attempt log"
      className="task-attempt-log"
      aside={
        <a className="hint" href={routeHref({ view: 'attempt', id: attemptId })}>
          The whole log of {attemptId}
        </a>
      }
    >
      {detail.data ? (
        <AttemptLog entries={newestLog(detail.data.log)} />
      ) : detail.error ? (
        <ErrorBox error={detail.error} onRetry={detail.reload} />
      ) : (
        <Loading />
      )}
    </Section>
  );
}

/** A runner agent's submissions, newest first, each with its outcome in plain words (design 6.13). */
function Submissions({ submissions }: { submissions: SubmissionRecord[] }) {
  return (
    <Section title="Submissions">
      <ol className="submission-records">
        {submissions.map((record) => {
          const outcome = submissionOutcome(record);
          return (
            <li key={record.id} className="submission-record">
              <div className="meta">
                <span className="submission-id mono">{record.id}</span> · <AttemptLink id={record.attemptId} /> ·{' '}
                <When ts={record.requestedAt} />
              </div>
              <p className={`submission-outcome toned tone-${outcome.tone}`}>{outcome.text}</p>
              {outcome.detail ? <p className="submission-detail pre muted">{outcome.detail}</p> : null}
              <p className="pre">
                <Linked text={record.summary} />
              </p>
              {record.evidence.length > 0 ? (
                <ul className="submission-evidence">
                  {record.evidence.map((item, index) => (
                    <li key={index} className="pre">
                      {item}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

/** The mark of a task only live chats may take, with the owned paths that keep runner agents off it (design 6.6). */
function LiveChatOnly({ task }: { task: Task }) {
  const paths = runnerForbiddenPaths(task).map((entry) => entry.path);
  return (
    <span
      className="chip tone-wait live-only"
      title={`Runner agents may not change ${paths.join(', ')}, so the scheduler leaves this task to live chats.`}
    >
      Live chat only
    </span>
  );
}

function Attention({ task }: { task: Task }) {
  if (task.status === 'blocked') {
    return (
      <div className={`card attention tone-${toneOf(task.status, task.blockedKind)}`}>
        <h2>{task.blockedKind ? BLOCKED_TITLES[task.blockedKind] : 'Blocked'}</h2>
        {task.blockedReason ? (
          <p className="pre">
            <Linked text={task.blockedReason} />
          </p>
        ) : null}
      </div>
    );
  }
  if (task.feedback && (task.status === 'claimed' || task.status === 'working' || task.status === 'ready')) {
    return (
      <div className="card attention tone-trouble">
        <h2>Review feedback to address</h2>
        <p className="pre">{task.feedback}</p>
      </div>
    );
  }
  return null;
}

/** A refused clone hand-back is a command result, which sends no event, so a taken-over task also reloads this often. */
const TAKEOVER_REFRESH_MS = 10_000;

/**
 * A task a person took over (design 6.12). While the runner stops the agent and readies its clone, the take-over is in
 * progress; then come the commands to go on with the work, on the runner's laptop and anywhere, and the hand-back.
 * Without a local command only the one for anywhere shows, and a take-over that failed shows the runner's error. A
 * refused hand-back from the clone shows Attempt.takeover.error, and the hand-back is offered again (X-37); while one
 * is on its way the page says so and offers none (X-49). Until the runners have loaded, a missing runner is not yet
 * an offline one, so the hand-back waits for them.
 */
function TakeoverPanel({
  task,
  attempt,
  runner,
  runnersLoaded,
  onDone,
}: {
  task: Task;
  attempt: Attempt | null;
  runner: Runner | null;
  runnersLoaded: boolean;
  onDone: () => void;
}) {
  const { me } = useHub();
  useEffect(() => {
    const timer = setInterval(onDone, TAKEOVER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [onDone]);
  const state = takeoverState(task, attempt);
  const allowed = canHandBack(task, attempt, runner, me);
  const person = attempt?.stopRequested?.by ?? null;
  const runnerId = attempt?.runnerId ?? null;

  return (
    <Section title="Take-over" className="takeover takeover-card">
      {state.kind === 'preparing' ? (
        <p className="taking-over">
          <span className="lamp tone-active pulse" /> Taking over… The runner is stopping the agent: it writes a handoff
          note, pushes its work and readies its clone for you. The commands show here once it reports.
        </p>
      ) : null}
      {state.kind === 'failed' ? (
        <p className="error pre">
          The runner could not ready its clone: {state.error}. The agent's work is pushed, so go on from it anywhere.
        </p>
      ) : null}
      {state.kind === 'unrecorded' ? (
        <p className="muted">The attempt ended before its runner reported the commands to go on with the work.</p>
      ) : null}
      {state.kind === 'ready' && state.local ? (
        <>
          <h3>On the runner's laptop</h3>
          <CommandBlock label="The command on the runner's laptop" command={state.local} />
        </>
      ) : null}
      {state.kind === 'ready' || state.kind === 'failed' ? (
        <>
          <h3>Anywhere</h3>
          <CommandBlock label="The command for anywhere" command={state.anywhere} />
          <p className="hint">
            It pushes your work to <code>{state.ref}</code>. Hand the task back from that ref when you are done, or from
            the runner's clone if you worked there.
          </p>
        </>
      ) : null}
      {state.kind === 'ready' && state.handbackError ? (
        <p className="handback-refused warn-text pre">
          The hand-back from the clone was refused: {state.handbackError}. Stop what still runs there, then hand it back
          again.
        </p>
      ) : null}
      {state.kind === 'handing_back' ? (
        <p className="handing-back">
          <span className="lamp tone-active pulse" /> Handing back… {who(state.by)} asked the runner for the clone's work{' '}
          <When ts={state.at} />. The task stays taken over until the runner pushes it, or the hub stops waiting.
        </p>
      ) : null}
      {!runnersLoaded ? null : allowed ? (
        <HandBackForm
          taskId={task.id}
          takeoverRef={attempt?.takeover?.ref ?? ''}
          runner={runner}
          runnerId={runnerId}
          onDone={onDone}
        />
      ) : state.kind !== 'preparing' && state.kind !== 'handing_back' && person ? (
        <p className="muted">
          Only {who(person)} hands it back while {runnerId ?? 'its runner'} is online.
        </p>
      ) : null}
    </Section>
  );
}

/** The runner states without a link to the hub (hub lead.ts UNLINKED): a hand_back cannot reach such a runner. */
const UNLINKED: ReadonlySet<Runner['state']> = new Set(['offline', 'needs_login', 'incompatible']);

/**
 * Hands a taken-over task back (design 6.12): from the runner's clone, which the runner harvests and pushes, or from a
 * ref the person pushed, prefilled with the take-over ref (X-22). A ref needs the full 40-hex sha of its commit,
 * because the next runner may fetch it by sha (X-24).
 */
function HandBackForm({
  taskId,
  takeoverRef,
  runner,
  runnerId,
  onDone,
}: {
  taskId: string;
  takeoverRef: string;
  runner: Runner | null;
  runnerId: string | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState<'clone' | 'ref' | null>(null);
  const [ref, setRef] = useState(takeoverRef);
  const [sha, setSha] = useState('');
  const action = useAction();
  const source: HandbackSource | null = open === 'clone' ? 'clone' : open === 'ref' ? handbackSource({ ref, sha }) : null;
  // Only a runner without a link makes the task go ready at once; a crash_loop or disk_low runner still gets the
  // hand_back, so the task waits for what its clone pushes, as with an online one.
  const unlinked = runner === null || UNLINKED.has(runner.state);

  const choose = (next: 'clone' | 'ref') => {
    setOpen(open === next ? null : next);
    setRef(takeoverRef);
    setSha('');
    action.clearError();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!source) return;
    if ((await action.run(() => api.handBack(taskId, source))).ok) {
      setOpen(null);
      onDone();
    }
  };

  return (
    <div className="handback">
      <div className="actions">
        <button aria-pressed={open === 'clone'} onClick={() => choose('clone')}>
          Hand back from the clone
        </button>
        <button aria-pressed={open === 'ref'} onClick={() => choose('ref')}>
          Hand back from a ref
        </button>
      </div>
      {open ? (
        <form className="action-form handback-form" onSubmit={submit}>
          {open === 'clone' ? (
            <p>
              {unlinked
                ? `${runnerId ?? 'Its runner'} is not online, so the task goes back to Ready at once, from its last ` +
                  'pushed work; what is in the clone follows as late work once the runner is back.'
                : 'The runner pushes everything in its clone, your commits and uncommitted changes, and the task goes ' +
                  'back to Ready from there. Close the agent and your tools in the clone first. If the runner does ' +
                  "not answer in time, the task goes back to Ready from its last pushed work, and the clone's work " +
                  'follows as late work.'}
            </p>
          ) : (
            <>
              <label>
                The ref you pushed
                <input name="ref" className="mono" value={ref} onChange={(event) => setRef(event.target.value)} />
              </label>
              <label>
                The full sha of its commit (git rev-parse HEAD)
                <input
                  name="sha"
                  className="mono"
                  value={sha}
                  placeholder="40 hex characters"
                  onChange={(event) => setSha(event.target.value)}
                  autoFocus
                />
              </label>
            </>
          )}
          <div className="row">
            <button className="confirm-action primary" disabled={!source || action.busy}>
              {open === 'clone' ? 'Hand back from the clone' : 'Hand back from this ref'}
            </button>
            <button type="button" onClick={() => setOpen(null)}>
              Never mind
            </button>
          </div>
          {action.error ? <p className="error">{action.error}</p> : null}
        </form>
      ) : null}
    </div>
  );
}

/**
 * People's actions on the task. On a task a runner agent holds, the agent's actions (stop, stop and hold, replace,
 * take over) stand in for M1's Release claim (design 11).
 */
function Actions({
  task,
  holder,
  attempt,
  runner,
  onDone,
}: {
  task: Task;
  holder: TaskHolder;
  attempt: Attempt | null;
  runner: Runner | null;
  onDone: () => void;
}) {
  const available = actionsFor(task, holder);
  const [open, setOpen] = useState<TaskAction | null>(null);
  const [text, setText] = useState('');
  const action = useAction();
  // Where actionsFor drops Release claim; runnerActionsFor offers nothing on a runner task in any other status.
  const onRunner = holder === 'runner' && attempt !== null && (task.status === 'claimed' || task.status === 'working');
  if (available.length === 0 && !onRunner) return null;
  const spec = open ? TASK_ACTIONS[open] : null;
  const body = open ? actionBody(open, text) : null;

  const choose = (next: TaskAction) => {
    setOpen(open === next ? null : next);
    setText('');
    action.clearError();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!open || !body) return;
    if ((await action.run(() => api.taskAction(task.id, open, body))).ok) {
      setOpen(null);
      onDone();
    }
  };

  return (
    <section className="card actions-card" aria-label="Actions">
      <p className="action-hint">{actionHint(task, holder)}</p>
      {onRunner ? (
        // Keyed by the attempt: the agent routes act on whatever attempt the agent has now, so a form opened for an
        // attempt that was since replaced must not survive into its successor's.
        <RunnerActions key={attempt.id} agentId={attempt.agentId} attempt={attempt} runner={runner} onDone={onDone} />
      ) : null}
      <div className="actions">
        {available.map((name) => (
          <button
            key={name}
            className={TASK_ACTIONS[name].danger ? 'danger' : name === 'accept' ? 'primary' : undefined}
            aria-pressed={open === name}
            onClick={() => choose(name)}
          >
            {TASK_ACTIONS[name].label}
          </button>
        ))}
      </div>
      {spec && open ? (
        <form className="action-form" onSubmit={submit}>
          <label>
            {spec.prompt}
            {spec.field === 'sha' ? (
              <input className="mono" value={text} placeholder="3f2a9c1" onChange={(event) => setText(event.target.value)} autoFocus />
            ) : (
              <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} autoFocus />
            )}
          </label>
          <div className="row">
            <button className={`confirm-action ${spec.danger ? 'danger solid' : 'primary'}`} disabled={!body || action.busy}>
              {spec.confirm}
            </button>
            <button type="button" onClick={() => setOpen(null)}>
              Never mind
            </button>
          </div>
          {action.error ? <p className="error">{action.error}</p> : null}
        </form>
      ) : null}
    </section>
  );
}

function Contract({ task }: { task: Task }) {
  return (
    <Section title="Contract">
      <h3>Objective</h3>
      <p className="pre">
        <Linked text={task.objective} />
      </p>
      {task.why ? (
        <>
          <h3>Why</h3>
          <p className="pre">{task.why}</p>
        </>
      ) : null}
      <h3>Acceptance</h3>
      <ol className="criteria">
        {task.acceptance.map((criterion) => (
          <li key={criterion.id}>
            <span className="criterion-id">{criterion.id}</span>
            <span>
              {criterion.assertion}
              {criterion.evidence ? <span className="evidence"> · {evidenceText(criterion.evidence)}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {task.nonGoals.length > 0 ? (
        <>
          <h3>Out of scope</h3>
          <ul>
            {task.nonGoals.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      {task.checks.length > 0 ? (
        <>
          <h3>Checks</h3>
          <ul className="plain">
            {task.checks.map((check) => (
              <li key={check.name}>
                {check.name} <code>{check.cmd}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {task.ownedPaths.length > 0 ? (
        <>
          <h3>Owned paths</h3>
          <ul className="plain">
            {task.ownedPaths.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {task.dependsOn.length > 0 ? (
        <>
          <h3>Depends on</h3>
          <p className="links">
            {task.dependsOn.map((dependency) => (
              <TaskLink key={dependency} id={dependency} />
            ))}
          </p>
        </>
      ) : null}
    </Section>
  );
}

function Submission({ task, repo }: { task: Task; repo: string | undefined }) {
  const submission = task.submission;
  if (!submission) return null;
  return (
    <Section title="Submission">
      <p className="meta">
        {submission.by} · <When ts={submission.submittedAt} />
        {submission.branch ? (
          <>
            {' · '}
            <RepoRef repo={repo} kind="branch" refName={submission.branch} />
          </>
        ) : null}
        {submission.headSha ? (
          <>
            {' · '}
            <RepoRef repo={repo} kind="commit" refName={submission.headSha} />
          </>
        ) : null}
      </p>
      <p className="pre">
        <Linked text={submission.summary} />
      </p>
      {submission.evidence.length > 0 ? (
        <>
          <h3>Evidence</h3>
          <ul>
            {submission.evidence.map((item, index) => (
              <li key={index} className="pre">
                {item}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {task.mergedSha ? (
        <p className="meta">
          Merged at <RepoRef repo={repo} kind="commit" refName={task.mergedSha} />
        </p>
      ) : null}
    </Section>
  );
}

function NoteItem({ note }: { note: TaskNote }) {
  return (
    <li className="note">
      <div className="meta">
        <span className={`chip tone-${NOTE_TONES[note.kind]}`}>{NOTE_LABELS[note.kind]}</span> {who(note.author)} ·{' '}
        <When ts={note.createdAt} />
      </div>
      <p className="pre">
        <Linked text={note.body} />
      </p>
    </li>
  );
}

function Notes({ notes }: { notes: TaskNote[] }) {
  return (
    <Section title="Notes">
      {notes.length === 0 ? (
        <p className="muted">Agents post progress notes here.</p>
      ) : (
        <ol className="notes">
          {[...notes].reverse().map((note) => (
            <NoteItem key={note.id} note={note} />
          ))}
        </ol>
      )}
    </Section>
  );
}

/** A step's heading: 'a1 → a2', or where the chain starts or ends. */
function stepTitle({ from, to }: Pick<NoteGroup, 'from' | 'to'>): string {
  if (from && to) return `${attemptLabel(from)} → ${attemptLabel(to)}`;
  if (to) return `The task → ${attemptLabel(to)}`;
  if (from) return `${attemptLabel(from)} → the next attempt`;
  return 'Notes from before attempts';
}

/**
 * Each step from one attempt to the next (design 6.8): what the attempt left, its handoff and any late work, beside
 * how its successor read it back in its restatement, so a person sees at a glance whether the handoff landed.
 */
function Handoffs({ groups }: { groups: NoteGroup[] }) {
  return (
    <Section title="Handoffs" className="handoffs">
      <ol className="note-steps">
        {groups.map((group) => (
          <li key={`${group.from}:${group.to}`} className="note-step">
            <h3 className="note-step-head">{stepTitle(group)}</h3>
            <div className="note-columns">
              <div className="note-left">
                <p className="note-side">{group.from ? `What ${attemptLabel(group.from)} left` : 'Left before'}</p>
                {group.handoffs.length + group.lateWork.length > 0 ? (
                  <ol className="notes">
                    {[...group.handoffs, ...group.lateWork].map((note) => (
                      <NoteItem key={note.id} note={note} />
                    ))}
                  </ol>
                ) : (
                  <p className="muted">No handoff note.</p>
                )}
              </div>
              <div className="note-right">
                <p className="note-side">{group.to ? `How ${attemptLabel(group.to)} read it` : 'Read back'}</p>
                {group.restatements.length > 0 ? (
                  <ol className="notes">
                    {group.restatements.map((note) => (
                      <NoteItem key={note.id} note={note} />
                    ))}
                  </ol>
                ) : (
                  <p className="muted">{group.to ? 'No restatement.' : 'No attempt has read it yet.'}</p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
