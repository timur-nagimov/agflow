// Managed requirements and ChatGPT identity for the zero-model preflight.
import { createHash } from 'node:crypto';
import type { PlanType } from './protocol/PlanType';
import type {
  ApprovalsReviewer,
  ConfigLayerSource,
  ConfigReadResponse,
  ConfigRequirements,
  ConfigRequirementsReadResponse,
  GetAccountResponse,
} from './protocol/v2';

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

/** null for a call that failed. */
export function classifyCodexPolicy(input: {
  requirements: ConfigRequirementsReadResponse | null;
  config: ConfigReadResponse | null;
}): { managedPolicy: boolean; problem: string | null } {
  // 0.159.2 sends this field even though its generated ConfigRequirements omits it.
  const requirements: (ConfigRequirements & { allowedApprovalsReviewers?: ApprovalsReviewer[] | null }) | null =
    input.requirements?.requirements ?? null;
  const managedPolicy =
    input.requirements === null ||
    input.config === null ||
    requirements !== null ||
    input.config.layers === null ||
    input.config.layers.some((layer) => managedLayer(layer.name.type));
  // A managed layer outranks the thread's web_search override, and no later check sees web search.
  const webSearch = input.config?.config.web_search ?? null;
  const webSearchOrigin = input.config?.origins.web_search?.name.type;
  let problem: string | null = null;
  if (requirements?.allowedSandboxModes != null && !requirements.allowedSandboxModes.includes('workspace-write')) {
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
  return { managedPolicy, problem };
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
