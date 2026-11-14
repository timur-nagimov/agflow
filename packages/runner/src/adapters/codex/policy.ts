// Managed requirements and ChatGPT identity for the zero-model preflight.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PlanType } from './protocol/PlanType';
import type { ConfigLayerSource, ConfigReadResponse, ConfigRequirements, GetAccountResponse } from './protocol/v2';

// A re-pin must explicitly classify every new layer and plan.
const MANAGED_LAYERS = {
  packagedDefaults: false,
  mdm: true,
  system: false,
  enterpriseManaged: true,
  user: false,
  project: false,
  sessionFlags: false,
  legacyManagedConfigTomlFromFile: true,
  legacyManagedConfigTomlFromMdm: true,
} satisfies Record<ConfigLayerSource['type'], boolean>;

/** A layer type the generated types do not know counts as managed: they lag 0.159.2's wire format. */
function managedLayer(type: string): boolean {
  return (MANAGED_LAYERS as Record<string, boolean | undefined>)[type] ?? true;
}

const PLAN_NAMES = {
  free: 'ChatGPT Free',
  go: 'ChatGPT Go',
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
  prolite: 'ChatGPT Pro Lite',
  promax: 'ChatGPT Pro Max',
  team: 'ChatGPT Team',
  self_serve_business_prolite: 'ChatGPT Business Pro Lite',
  self_serve_business_usage_based: 'ChatGPT Business Usage Based',
  business: 'ChatGPT Business',
  ent26: 'ChatGPT Enterprise',
  enterprise_cbp_automation: 'ChatGPT Enterprise Automation',
  enterprise_cbp_usage_based: 'ChatGPT Enterprise Usage Based',
  enterprise: 'ChatGPT Enterprise',
  edu: 'ChatGPT Edu',
  edu_plus: 'ChatGPT Edu Plus',
  edu_pro: 'ChatGPT Edu Pro',
  unknown: 'ChatGPT (unknown plan)',
} satisfies Record<PlanType, string>;

/** A restriction a policy may set: the values it allows, or null for none. */
const allowedValues = z.array(z.string()).nullish();

/**
 * The approval policies a policy may allow, as AskForApproval generates them: names, and the granular object, which
 * agflow never configures. Only on-request is looked for among them.
 */
const allowedApprovalPolicies = z
  .array(z.union([z.string(), z.strictObject({ granular: z.record(z.string(), z.boolean()) })]))
  .nullish();

/**
 * The fields of the requirements the classification reads. The generated type names all but one of them, so a re-pin
 * that renames any of those stops compiling here; allowedApprovalsReviewers is on 0.159.2's wire, though its generated
 * type omits it. autoReview is read only for whether it is set.
 */
const READ_FIELDS = {
  allowedApprovalsReviewers: allowedValues,
  allowedApprovalPolicies,
  allowedSandboxModes: allowedValues,
  autoReview: z.unknown().optional(),
} satisfies Partial<Record<keyof ConfigRequirements | 'allowedApprovalsReviewers', unknown>>;

/**
 * What configRequirements/read must answer to be read at all: a requirements key, null on a device with none, or an
 * object whose read fields have the generated shapes. Every other field passes through, to be read for what its name
 * says about approvals.
 */
const RequirementsAnswerSchema = z.looseObject({ requirements: z.looseObject(READ_FIELDS).nullable() });
type RequirementsAnswer = z.output<typeof RequirementsAnswerSchema>;

/**
 * A name that speaks of approvals: an approval, an approver, the reviewers that answer them, or the guardian that may
 * be one. autoReview, which configures the auto_review reviewer, says nothing by its name, so it is a read field.
 */
const SPEAKS_OF_APPROVALS = /approv|reviewer|guardian/i;

/**
 * The requirements' own fields whose names and contents the name rule leaves alone: the read fields, which the schema
 * reads whole, and the restrictions of computer use and the external browser. Those restrict computer use and the
 * browser and nothing else (design 6.10, Managed devices), though the generated types name persistent approvals there.
 */
const NOT_SCANNED: ReadonlySet<string> = new Set([
  ...Object.keys(READ_FIELDS),
  ...(['computerUse', 'browserUse'] satisfies (keyof ConfigRequirements)[]),
]);

/**
 * Whether any field of the answer, at any depth, speaks of approvals by its name, outside the requirements' fields the
 * rule leaves alone. Such a field is one the runner does not recognise, so what it says is unknown. The answer is
 * walked as it came: zod's output leaves out a __proto__ key, and a field under one would go unseen.
 */
function unrecognisedApprovalField(answer: unknown): boolean {
  const requirements = (answer as { requirements?: unknown }).requirements;
  const pending: unknown[] = [answer];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null) continue;
    for (const [key, child] of Object.entries(value)) {
      if (value === requirements && NOT_SCANNED.has(key)) continue;
      if (SPEAKS_OF_APPROVALS.test(key)) return true;
      pending.push(child);
    }
  }
  return false;
}

/**
 * Whether requirements that were read reserve approvals to the owner: they do when they speak about reviewers, set auto
 * review, or allow approval policies without on-request. Silence the runner did not hear is not permission (design 4,
 * Device policy): a field it does not recognise that speaks of approvals reserves them, and so does either field that
 * says who answers left out. `raw` is the answer as it came, which `answer` was parsed from.
 */
function reservesApprovals(raw: unknown, answer: RequirementsAnswer): boolean {
  if (unrecognisedApprovalField(raw)) return true;
  const { requirements } = answer;
  if (requirements === null) return false;
  const { allowedApprovalsReviewers: reviewers, allowedApprovalPolicies: policies, autoReview } = requirements;
  if (reviewers === undefined || policies === undefined) return true;
  // Auto review sends the approvals of the models it names to the auto_review reviewer, whoever agflow would ask.
  if (autoReview !== undefined && autoReview !== null) return true;
  return reviewers !== null || (policies !== null && !policies.includes('on-request'));
}

/**
 * managedPolicy says only that the device has managed configuration; whether that configuration regulates who answers
 * approvals is the separate fact approvalsReservedToOwner (design 6.10). Requirements the runner could not read leave
 * both true: a call that failed, and an answer of a shape it does not know. Such an answer is a policy the runner
 * cannot read, so it is a problem too, and the vendor runs nothing at all (design 4, Device policy); a call that failed
 * blocks nothing by itself.
 */
export function classifyCodexPolicy(input: {
  /** The configRequirements/read answer as it came, or null for a call that failed. */
  requirements: unknown;
  /** The config/read answer, or null for a call that failed. */
  config: ConfigReadResponse | null;
}): { managedPolicy: boolean; approvalsReservedToOwner: boolean; problem: string | null } {
  const parsed = RequirementsAnswerSchema.safeParse(input.requirements);
  const answer = parsed.success ? parsed.data : null;
  const requirements = answer?.requirements ?? null;
  const managedPolicy =
    answer === null ||
    input.config === null ||
    requirements !== null ||
    input.config.layers === null ||
    input.config.layers.some((layer) => managedLayer(layer.name.type));
  // Managed layers alone say nothing about approvals: only the requirements do, or their being unknown.
  const approvalsReservedToOwner = answer === null || reservesApprovals(input.requirements, answer);
  // A managed layer outranks the thread's web_search override, and no later check sees web search.
  const webSearch = input.config?.config.web_search ?? null;
  const webSearchOrigin = input.config?.origins.web_search?.name.type;
  let problem: string | null = null;
  if (input.requirements !== null && answer === null) {
    problem = 'cannot read the managed policy';
  } else if (
    requirements?.allowedSandboxModes != null &&
    !requirements.allowedSandboxModes.includes('workspace-write')
  ) {
    problem = 'managed policy does not allow workspace-write';
  } else if (
    requirements?.allowedApprovalPolicies != null &&
    !requirements.allowedApprovalPolicies.includes('on-request')
  ) {
    problem = 'managed policy does not allow the on-request approval policy';
  } else if (
    requirements?.allowedApprovalsReviewers != null &&
    !requirements.allowedApprovalsReviewers.includes('user')
  ) {
    problem = 'managed policy does not allow the user approvals reviewer';
  } else if (
    webSearch !== null &&
    webSearch !== 'disabled' &&
    webSearchOrigin !== undefined &&
    managedLayer(webSearchOrigin)
  ) {
    problem = 'managed policy turns on web search';
  }
  return { managedPolicy, approvalsReservedToOwner, problem };
}

export function codexAccountIdentity(account: GetAccountResponse['account']): {
  accountId: string | null;
  plan: string | null;
  problem: string | null;
} {
  if (account?.type === 'chatgpt') {
    return {
      accountId: account.email === null ? null : createHash('sha256').update(account.email).digest('hex').slice(0, 16),
      plan: PLAN_NAMES[account.planType],
      problem: null,
    };
  }
  return {
    accountId: null,
    plan: null,
    problem:
      account === null
        ? 'not logged in'
        : account.type === 'apiKey'
          ? 'an API key would replace the subscription'
          : 'Amazon Bedrock is not a ChatGPT login',
  };
}
