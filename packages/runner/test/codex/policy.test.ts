// Managed-policy and subscription identity checks, including the Mac's recorded MDM requirements.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { classifyCodexPolicy, codexAccountIdentity } from '../../src/adapters/codex/policy';
import type {
  ApprovalsReviewer,
  ConfigLayerSource,
  ConfigReadResponse,
  ConfigRequirements,
  ConfigRequirementsReadResponse,
  GetAccountResponse,
} from '../../src/adapters/codex/protocol/v2';

const recorded = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/requirements-managed.json`, 'utf8')) as {
  'configRequirements/read': ConfigRequirementsReadResponse;
  'config/read': ConfigReadResponse;
};
const requirements = recorded['configRequirements/read'];
const config = recorded['config/read'];

function layers(...sources: ConfigLayerSource[]): ConfigReadResponse {
  return { ...config, layers: sources.map((name) => ({ name, version: 'test', config: {}, disabledReason: null })) };
}

function restricted(
  overrides: Partial<ConfigRequirements & { allowedApprovalsReviewers: ApprovalsReviewer[] | null }>,
) {
  return { requirements: { ...requirements.requirements!, ...overrides } };
}

describe('classifyCodexPolicy', () => {
  test('the recorded MDM sample is managed, reserves no approvals and is ready', () => {
    expect(config.layers?.some((layer) => layer.name.type === 'legacyManagedConfigTomlFromMdm')).toBe(true);
    // This Mac's profile: sandbox modes, remote control and features, and nothing at all about approvals.
    expect(requirements.requirements).toMatchObject({
      allowedSandboxModes: ['read-only', 'workspace-write'],
      allowRemoteControl: false,
      featureRequirements: { browser_use_external: false, computer_use: false },
      allowedApprovalPolicies: null,
      allowedApprovalsReviewers: null,
    });
    expect(classifyCodexPolicy({ requirements, config })).toEqual({
      managedPolicy: true,
      approvalsReservedToOwner: false,
      problem: null,
    });
  });

  test('user, system and sessionFlags alone are unmanaged', () => {
    expect(
      classifyCodexPolicy({
        requirements: { requirements: null },
        config: layers(
          { type: 'user', file: '/tmp/config.toml', profile: null },
          { type: 'system', file: '/etc/codex/config.toml' },
          { type: 'sessionFlags' },
        ),
      }),
    ).toEqual({ managedPolicy: false, approvalsReservedToOwner: false, problem: null });
    expect(classifyCodexPolicy({ requirements, config: layers() }).managedPolicy).toBe(true);
  });

  const managed: ConfigLayerSource[] = [
    { type: 'mdm', domain: 'test', key: 'test' },
    { type: 'enterpriseManaged', id: 'test', name: 'test' },
    { type: 'legacyManagedConfigTomlFromFile', file: '/tmp/managed.toml' },
    { type: 'legacyManagedConfigTomlFromMdm' },
  ];
  for (const source of managed) {
    // Managed configuration that says nothing about approvals leaves them to whoever the hub allows (6.10).
    test(`${source.type} alone is managed and reserves no approvals`, () => {
      expect(classifyCodexPolicy({ requirements: { requirements: null }, config: layers(source) })).toEqual({
        managedPolicy: true,
        approvalsReservedToOwner: false,
        problem: null,
      });
    });
  }

  test('an unknown layer type and missing layers count as managed', () => {
    const unknown = { type: 'cloudManaged' } as unknown as ConfigLayerSource;
    expect(classifyCodexPolicy({ requirements: { requirements: null }, config: layers(unknown) })).toEqual({
      managedPolicy: true,
      approvalsReservedToOwner: false,
      problem: null,
    });
    expect(classifyCodexPolicy({ requirements: { requirements: null }, config: { ...config, layers: null } })).toEqual({
      managedPolicy: true,
      approvalsReservedToOwner: false,
      problem: null,
    });
  });

  test('web search turned on by a managed layer is a problem; disabled, or set by the user, is not', () => {
    const mdm: ConfigLayerSource = { type: 'legacyManagedConfigTomlFromMdm' };
    const user: ConfigLayerSource = { type: 'user', file: '/tmp/config.toml', profile: null };
    const webSearch = (value: 'live' | 'cached' | 'disabled', name: ConfigLayerSource): ConfigReadResponse => ({
      ...config,
      config: { ...config.config, web_search: value } as ConfigReadResponse['config'],
      origins: { ...config.origins, web_search: { name, version: 'test' } },
    });
    expect(classifyCodexPolicy({ requirements, config: webSearch('live', mdm) })).toEqual({
      managedPolicy: true,
      approvalsReservedToOwner: false,
      problem: 'managed policy turns on web search',
    });
    expect(classifyCodexPolicy({ requirements, config: webSearch('cached', mdm) }).problem).toBe(
      'managed policy turns on web search',
    );
    expect(classifyCodexPolicy({ requirements, config: webSearch('disabled', mdm) }).problem).toBeNull();
    expect(classifyCodexPolicy({ requirements, config: webSearch('live', user) }).problem).toBeNull();
  });

  test('either failed read counts as managed without itself blocking readiness', () => {
    // An unread requirements call leaves the policy on approvals unknown, which reserves them; an unread config
    // call does not, since the requirements answered for themselves.
    const cases = [
      [{ requirements: null, config: layers() }, true],
      [{ requirements: { requirements: null }, config: null }, false],
      [{ requirements: null, config: null }, true],
    ] as const;
    for (const [input, approvalsReservedToOwner] of cases)
      expect(classifyCodexPolicy(input)).toEqual({ managedPolicy: true, approvalsReservedToOwner, problem: null });
  });

  test('a policy that speaks about reviewers reserves approvals, even when it allows the user', () => {
    for (const reviewers of [['user'], ['user', 'auto_review'], []] as ApprovalsReviewer[][]) {
      const result = classifyCodexPolicy({ requirements: restricted({ allowedApprovalsReviewers: reviewers }), config });
      expect(result).toMatchObject({ managedPolicy: true, approvalsReservedToOwner: true });
    }
    // Allowing on-request is not speaking about reviewers: the administrator left that question open.
    expect(
      classifyCodexPolicy({ requirements: restricted({ allowedApprovalPolicies: ['on-request', 'never'] }), config }),
    ).toEqual({ managedPolicy: true, approvalsReservedToOwner: false, problem: null });
  });

  const restrictions = [
    // A sandbox restriction says nothing about approvals; the other two do.
    [restricted({ allowedSandboxModes: ['read-only'] }), 'workspace-write', false],
    [restricted({ allowedApprovalPolicies: ['never'] }), 'on-request', true],
    [restricted({ allowedApprovalsReviewers: ['auto_review'] }), 'user approvals reviewer', true],
  ] as const;
  for (const [requirements, reason, approvalsReservedToOwner] of restrictions) {
    test(`rejects policy excluding ${reason}`, () => {
      const result = classifyCodexPolicy({ requirements, config });
      expect(result.managedPolicy).toBe(true);
      expect(result.approvalsReservedToOwner).toBe(approvalsReservedToOwner);
      expect(result.problem).toContain(reason);
    });
  }

  test('null lists allow the required values; sandbox then approval then reviewer wins', () => {
    expect(
      classifyCodexPolicy({
        config,
        requirements: restricted({
          allowedSandboxModes: null,
          allowedApprovalPolicies: null,
          allowedApprovalsReviewers: null,
        }),
      }).problem,
    ).toBeNull();
    expect(
      classifyCodexPolicy({
        config,
        requirements: restricted({
          allowedSandboxModes: ['workspace-write'],
          allowedApprovalPolicies: ['on-request'],
          allowedApprovalsReviewers: ['user'],
        }),
      }).problem,
    ).toBeNull();
    expect(
      classifyCodexPolicy({
        config,
        requirements: restricted({
          allowedSandboxModes: [],
          allowedApprovalPolicies: [],
          allowedApprovalsReviewers: [],
        }),
      }).problem,
    ).toContain('workspace-write');
    expect(
      classifyCodexPolicy({
        config,
        requirements: restricted({
          allowedApprovalPolicies: [],
          allowedApprovalsReviewers: [],
        }),
      }).problem,
    ).toContain('on-request');
  });
});

describe('codexAccountIdentity', () => {
  test('hashes the email as given and labels a ChatGPT plan', () => {
    const email = 'Owner@Example.com';
    expect(codexAccountIdentity({ type: 'chatgpt', email, planType: 'plus' })).toEqual({
      accountId: createHash('sha256').update(email).digest('hex').slice(0, 16),
      plan: 'ChatGPT Plus',
      problem: null,
    });
    expect(codexAccountIdentity({ type: 'chatgpt', email: null, planType: 'plus' })).toEqual({
      accountId: null,
      plan: 'ChatGPT Plus',
      problem: null,
    });
  });

  const cases: [GetAccountResponse['account'], string][] = [
    [null, 'not logged in'],
    [{ type: 'apiKey' }, 'an API key would replace the subscription'],
    [{ type: 'amazonBedrock', usesCodexManagedCredentials: true }, 'not a ChatGPT login'],
  ];
  for (const [account, problem] of cases) {
    test(`rejects ${account?.type ?? 'no account'}`, () => {
      const result = codexAccountIdentity(account);
      expect(result.accountId).toBeNull();
      expect(result.plan).toBeNull();
      expect(result.problem).toContain(problem);
    });
  }
});
