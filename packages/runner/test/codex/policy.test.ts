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
  test('the recorded MDM sample is managed and ready', () => {
    expect(config.layers?.some((layer) => layer.name.type === 'legacyManagedConfigTomlFromMdm')).toBe(true);
    expect(classifyCodexPolicy({ requirements, config })).toEqual({ managedPolicy: true, problem: null });
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
    ).toEqual({ managedPolicy: false, problem: null });
    expect(classifyCodexPolicy({ requirements, config: layers() }).managedPolicy).toBe(true);
  });

  const managed: ConfigLayerSource[] = [
    { type: 'mdm', domain: 'test', key: 'test' },
    { type: 'enterpriseManaged', id: 'test', name: 'test' },
    { type: 'legacyManagedConfigTomlFromFile', file: '/tmp/managed.toml' },
    { type: 'legacyManagedConfigTomlFromMdm' },
  ];
  for (const source of managed) {
    test(`${source.type} alone is managed`, () => {
      expect(classifyCodexPolicy({ requirements: { requirements: null }, config: layers(source) })).toEqual({
        managedPolicy: true,
        problem: null,
      });
    });
  }

  test('an unknown layer type and missing layers count as managed', () => {
    const unknown = { type: 'cloudManaged' } as unknown as ConfigLayerSource;
    expect(classifyCodexPolicy({ requirements: { requirements: null }, config: layers(unknown) })).toEqual({
      managedPolicy: true,
      problem: null,
    });
    expect(classifyCodexPolicy({ requirements: { requirements: null }, config: { ...config, layers: null } })).toEqual({
      managedPolicy: true,
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
      problem: 'managed policy turns on web search',
    });
    expect(classifyCodexPolicy({ requirements, config: webSearch('cached', mdm) }).problem).toBe(
      'managed policy turns on web search',
    );
    expect(classifyCodexPolicy({ requirements, config: webSearch('disabled', mdm) }).problem).toBeNull();
    expect(classifyCodexPolicy({ requirements, config: webSearch('live', user) }).problem).toBeNull();
  });

  test('either failed read counts as managed without itself blocking readiness', () => {
    for (const input of [
      { requirements: null, config: layers() },
      { requirements: { requirements: null }, config: null },
      { requirements: null, config: null },
    ])
      expect(classifyCodexPolicy(input)).toEqual({ managedPolicy: true, problem: null });
  });

  const restrictions = [
    [restricted({ allowedSandboxModes: ['read-only'] }), 'workspace-write'],
    [restricted({ allowedApprovalPolicies: ['never'] }), 'on-request'],
    [restricted({ allowedApprovalsReviewers: ['auto_review'] }), 'user approvals reviewer'],
  ] as const;
  for (const [requirements, reason] of restrictions) {
    test(`rejects policy excluding ${reason}`, () => {
      const result = classifyCodexPolicy({ requirements, config });
      expect(result.managedPolicy).toBe(true);
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
