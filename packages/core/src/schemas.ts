import { z } from 'zod';
import { TARGET_PATTERN } from './targets';

export const VendorSchema = z.enum(['claude', 'codex']);
export const RoleSchema = z.enum(['lead', 'worker']);
export const TaskKindSchema = z.enum(['code', 'research', 'review', 'curation']);
export const TaskIdSchema = z.string().regex(/^T-\d+$/, 'expected a task id like T-12');
export const BranchSchema = z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/, 'expected a git branch name');
export const CommitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/, 'expected a commit sha');
const TaskRefSchema = z
  .string()
  .regex(/^(T-\d+|#\d+)$/, 'expected a task id like T-12 or a batch reference like #1');

export const EvidenceSchema = z.object({
  kind: z.enum(['command', 'artifact', 'review']),
  cmd: z.string().max(1000).optional(),
  expect: z.string().max(1000).optional(),
  path: z.string().max(500).optional(),
  rubric: z.string().max(2000).optional(),
});

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(20),
  assertion: z.string().min(1).max(2000),
  evidence: EvidenceSchema.optional(),
});

export const TaskCheckSchema = z.object({
  name: z.string().min(1).max(100),
  cmd: z.string().min(1).max(1000),
  timeoutS: z.number().int().positive().max(86_400).optional(),
});

const contractFields = {
  title: z.string().min(1).max(200),
  kind: TaskKindSchema,
  objective: z.string().min(1).max(4000),
  why: z.string().max(2000),
  nonGoals: z.array(z.string().min(1).max(500)).max(20),
  acceptance: z.array(AcceptanceCriterionSchema).min(1).max(30),
  checks: z.array(TaskCheckSchema).max(20),
  ownedPaths: z.array(z.string().min(1).max(300)).max(50),
  dependsOn: z.array(TaskIdSchema).max(50),
  priority: z.number().int().min(0).max(9),
};

export const NewTaskSchema = z.object({
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

export const CreateTasksInputSchema = z.object({ tasks: z.array(NewTaskSchema).min(1).max(20) });

export const TaskPatchSchema = z
  .object(contractFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'the patch is empty');
export type TaskPatch = z.output<typeof TaskPatchSchema>;

export const UpdateGoalInputSchema = z.object({
  text: z.string().min(1).max(20_000),
  baseVersion: z.number().int().min(0),
});
export const GoalNoteInputSchema = z.object({ text: z.string().min(1).max(4000) });
export const GoalDiffQuerySchema = z.object({
  from: z.coerce.number().int().min(0),
  to: z.coerce.number().int().min(1),
});
export const PauseInputSchema = z.object({ paused: z.boolean() });

export const TargetSchema = z
  .string()
  .regex(TARGET_PATTERN, 'expected lead, all, humans, agent:A-<n> or task:T-<n>');
export const SendMessageInputSchema = z.object({
  to: TargetSchema,
  body: z.string().min(1).max(8000),
  taskId: TaskIdSchema.optional(),
  replyTo: z.number().int().positive().optional(),
  standingRule: z.boolean().optional(),
});
export const AckInputSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) });

export const ClaimInputSchema = z.object({ branch: BranchSchema.optional() });
export const ProgressInputSchema = z.object({ note: z.string().min(1).max(4000) });
export const SubmitInputSchema = z.object({
  summary: z.string().min(1).max(8000),
  evidence: z.array(z.string().min(1).max(2000)).max(50).default([]),
  branch: BranchSchema.optional(),
  headSha: CommitShaSchema.optional(),
});
export const ReasonInputSchema = z.object({ reason: z.string().min(1).max(4000) });
export const ImpossibleInputSchema = z.object({ evidence: z.string().min(1).max(8000) });
export const HandoffInputSchema = z.object({ note: z.string().min(1).max(16_000) });
export const FeedbackInputSchema = z.object({ feedback: z.string().min(1).max(8000) });
export const NoteInputSchema = z.object({ note: z.string().min(1).max(4000).optional() });
export const MarkMergedInputSchema = z.object({ sha: CommitShaSchema.optional() });

export const SessionStartInputSchema = z.object({
  vendor: VendorSchema,
  sessionId: z.string().min(1).max(200),
  role: RoleSchema.default('worker'),
  label: z.string().max(200).optional(),
});
export const HelloInputSchema = z.object({ code: z.string().min(4).max(20) });
export const LiveSessionQuerySchema = z.object({
  vendor: VendorSchema,
  sessionId: z.string().min(1).max(200),
});
export const StopCheckInputSchema = LiveSessionQuerySchema.extend({
  stopHookActive: z.boolean().default(false),
});

export const CliLoginApproveInputSchema = z.object({
  code: z.string().min(16).max(128),
  label: z.string().max(200).optional(),
});
