import { z } from 'zod';
import { isSupportedPattern } from './paths';
import { TARGET_PATTERN } from './targets';

// Request bodies use strict objects: a misspelled or snake_case key (depends_on, owned_paths,
// stop_hook_active) is a 400, not a silently dropped field. Query schemas stay loose.
export const VendorSchema = z.enum(['claude', 'codex']);
export const RoleSchema = z.enum(['lead', 'worker']);
export const TaskKindSchema = z.enum(['code', 'research', 'review', 'curation']);
export const TaskIdSchema = z.string().regex(/^T-\d+$/, 'expected a task id like T-12');
export const BranchSchema = z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/, 'expected a git branch name');
export const CommitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/, 'expected a commit sha');
const TaskRefSchema = z
  .string()
  .regex(/^(T-\d+|#\d+)$/, 'expected a task id like T-12 or a batch reference like #1');

export const EvidenceSchema = z.strictObject({
  kind: z.enum(['command', 'artifact', 'review']),
  cmd: z.string().max(1000).optional(),
  expect: z.string().max(1000).optional(),
  path: z.string().max(500).optional(),
  rubric: z.string().max(2000).optional(),
});

export const AcceptanceCriterionSchema = z.strictObject({
  id: z.string().min(1).max(20),
  assertion: z.string().min(1).max(2000),
  evidence: EvidenceSchema.optional(),
});

export const TaskCheckSchema = z.strictObject({
  name: z.string().min(1).max(100),
  cmd: z.string().min(1).max(1000),
  timeoutS: z.number().int().positive().max(86_400).optional(),
});

const OwnedPathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    isSupportedPattern,
    'expected a repo-relative glob without a leading "/" or "!", a ".." segment, "\\" or "|" (write alternatives as {a,b})',
  );

const contractFields = {
  title: z.string().min(1).max(200),
  kind: TaskKindSchema,
  objective: z.string().min(1).max(4000),
  why: z.string().max(2000),
  nonGoals: z.array(z.string().min(1).max(500)).max(20),
  acceptance: z.array(AcceptanceCriterionSchema).min(1).max(30),
  checks: z.array(TaskCheckSchema).max(20),
  ownedPaths: z.array(OwnedPathSchema).max(50),
  dependsOn: z.array(TaskIdSchema).max(50),
  priority: z.number().int().min(0).max(9),
};

export const NewTaskSchema = z.strictObject({
  ...contractFields,
  kind: TaskKindSchema.default('code'),
  why: contractFields.why.default(''),
  nonGoals: contractFields.nonGoals.default([]),
  checks: contractFields.checks.default([]),
  ownedPaths: contractFields.ownedPaths.default([]),
  dependsOn: z.array(TaskRefSchema).max(50).default([]),
  priority: contractFields.priority.default(5),
});
export type NewTask = z.output<typeof NewTaskSchema>;
export type NewTaskInput = z.input<typeof NewTaskSchema>;

export const CreateTasksInputSchema = z.strictObject({ tasks: z.array(NewTaskSchema).min(1).max(20) });

export const TaskPatchSchema = z
  .strictObject(contractFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'the patch is empty');
export type TaskPatch = z.output<typeof TaskPatchSchema>;

export const UpdateGoalInputSchema = z.strictObject({
  text: z.string().min(1).max(20_000),
  baseVersion: z.number().int().min(0),
});
export const GoalNoteInputSchema = z.strictObject({ text: z.string().min(1).max(4000) });
export const GoalDiffQuerySchema = z.object({
  from: z.coerce.number().int().min(0),
  to: z.coerce.number().int().min(1),
});
export const PauseInputSchema = z.strictObject({ paused: z.boolean() });

export const TargetSchema = z
  .string()
  .regex(TARGET_PATTERN, 'expected lead, all, humans, agent:A-<n> or task:T-<n>');
export const SendMessageInputSchema = z.strictObject({
  to: TargetSchema,
  body: z.string().min(1).max(8000),
  taskId: TaskIdSchema.optional(),
  replyTo: z.number().int().positive().optional(),
  standingRule: z.boolean().optional(),
});
export const AckInputSchema = z.strictObject({ ids: z.array(z.number().int().positive()).min(1).max(200) });

export const ClaimInputSchema = z.strictObject({ branch: BranchSchema.optional() });
export const ProgressInputSchema = z.strictObject({ note: z.string().min(1).max(4000) });
export const SubmitInputSchema = z.strictObject({
  summary: z.string().min(1).max(8000),
  evidence: z.array(z.string().min(1).max(2000)).max(50).default([]),
  branch: BranchSchema.optional(),
  headSha: CommitShaSchema.optional(),
});
export const ReasonInputSchema = z.strictObject({ reason: z.string().min(1).max(4000) });
export const ImpossibleInputSchema = z.strictObject({ evidence: z.string().min(1).max(8000) });
export const HandoffInputSchema = z.strictObject({ note: z.string().min(1).max(16_000) });
export const FeedbackInputSchema = z.strictObject({ feedback: z.string().min(1).max(8000) });
export const NoteInputSchema = z.strictObject({ note: z.string().min(1).max(4000).optional() });
export const MarkMergedInputSchema = z.strictObject({ sha: CommitShaSchema.optional() });

export const SessionStartInputSchema = z.strictObject({
  vendor: VendorSchema,
  sessionId: z.string().min(1).max(200),
  role: RoleSchema.default('worker'),
  label: z.string().max(200).optional(),
});
export const HelloInputSchema = z.strictObject({ code: z.string().min(4).max(20) });
const liveSessionFields = {
  vendor: VendorSchema,
  sessionId: z.string().min(1).max(200),
};
export const LiveSessionQuerySchema = z.object(liveSessionFields);
export const StopCheckInputSchema = z.strictObject({
  ...liveSessionFields,
  stopHookActive: z.boolean().default(false),
});

export const CliLoginApproveInputSchema = z.strictObject({
  code: z.string().min(16).max(128),
  label: z.string().max(200).optional(),
});
