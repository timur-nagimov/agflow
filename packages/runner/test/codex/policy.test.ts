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

  // What a requirements call that failed gives beside the recorded config: both facts true, no problem of their own.
  const unread = { managedPolicy: true, approvalsReservedToOwner: true, problem: null };
  const known: Record<string, unknown> = { ...requirements.requirements };
  const withFields = (fields: Record<string, unknown>) => ({ requirements: { ...known, ...fields } });
  const without = (field: string) => ({
    requirements: Object.fromEntries(Object.entries(known).filter(([key]) => key !== field)),
  });

  test('the shapes that once read as a policy saying nothing about approvals now reserve them', () => {
    // No requirements key at all: an answer the runner cannot read.
    expect(classifyCodexPolicy({ requirements: {}, config })).toEqual(unread);
    // Requirements without the two fields that say who answers: the runner heard nothing that leaves approvals open.
    expect(classifyCodexPolicy({ requirements: { requirements: {} }, config })).toEqual(unread);
    // The reviewers field as requirements.toml spells it: a field the runner does not recognise, about approvals.
    expect(
      classifyCodexPolicy({ requirements: { requirements: { allowed_approvals_reviewers: ['user'] } }, config }),
    ).toEqual(unread);
  });

  test('an answer of a shape the runner does not expect is read exactly as a call that failed', () => {
    const granular = {
      granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true },
    };
    const shapes: unknown[] = [
      {},
      { other: null },
      { requirements: 'none' },
      { requirements: [] },
      { requirements: 0 },
      [],
      'requirements',
      true,
      // A read field that is not a list of strings or null.
      withFields({ allowedApprovalsReviewers: 'user' }),
      withFields({ allowedApprovalPolicies: ['on-request', 7] }),
      withFields({ allowedApprovalPolicies: ['on-request', granular] }),
      withFields({ allowedSandboxModes: 'workspace-write' }),
      withFields({ allowedSandboxModes: {} }),
    ];
    const mdm: ConfigLayerSource = { type: 'legacyManagedConfigTomlFromMdm' };
    const configs: (ConfigReadResponse | null)[] = [
      config,
      layers(),
      layers({ type: 'user', file: '/tmp/config.toml', profile: null }),
      {
        ...config,
        config: { ...config.config, web_search: 'live' } as ConfigReadResponse['config'],
        origins: { ...config.origins, web_search: { name: mdm, version: 'test' } },
      },
      null,
    ];
    for (const shape of shapes) {
      for (const read of configs) {
        const failed = classifyCodexPolicy({ requirements: null, config: read });
        expect({ shape, result: classifyCodexPolicy({ requirements: shape, config: read }) }).toEqual({
          shape,
          result: failed,
        });
        expect(failed).toMatchObject({ managedPolicy: true, approvalsReservedToOwner: true });
      }
    }
  });

  test('a field the runner does not recognise that speaks of approvals reserves them, wherever it stands', () => {
    // The recorded sample names approvals only in the two fields that are read.
    expect(JSON.stringify(recorded['configRequirements/read']).match(/"[^"]*approval[^"]*":/gi)).toEqual([
      '"allowedApprovalPolicies":',
      '"allowedApprovalsReviewers":',
    ]);
    const fields: Record<string, unknown>[] = [
      { allowed_approvals_reviewers: ['user'] },
      // A known field renamed by one letter, and new fields, null or not.
      { allowedApprovalReviewers: ['user'] },
      { approvalsReviewer: 'user' },
      { defaultApprovalPolicy: null },
      // Deeper down, in fields the classification does not read.
      { network: { requireApproval: true } },
      { featureRequirements: { browser_use_external: false, computer_use: false, guardian_approval: true } },
      { hooks: [{ event: 'PreToolUse', approvalMode: 'never' }] },
      // Computer use's persistent approvals too: the field names approvals, so it is not read as silence.
      {
        computerUse: {
          allowLockedComputerUse: null,
          allowPersistentApproval: false,
          defaultAppAccess: null,
          macos: null,
          windows: null,
        },
      },
      // A known name where it is not read.
      { models: { allowedApprovalPolicies: ['never'] } },
    ];
    for (const field of fields) {
      expect({ field, result: classifyCodexPolicy({ requirements: withFields(field), config }) }).toEqual({
        field,
        result: unread,
      });
    }
    // Beside the requirements, where no field but requirements is read, the known names included.
    expect(classifyCodexPolicy({ requirements: { ...requirements, approvalsReviewer: 'user' }, config })).toEqual(unread);
    expect(
      classifyCodexPolicy({ requirements: { requirements: null, allowedApprovalsReviewers: null }, config }),
    ).toEqual(unread);
  });

  test('a field that does not speak of approvals passes through, and reserves nothing', () => {
    const open = { managedPolicy: true, approvalsReservedToOwner: false, problem: null };
    expect(classifyCodexPolicy({ requirements: withFields({ allowNewThing: true, newThing: { mode: 'strict' } }), config })).toEqual(open);
    expect(classifyCodexPolicy({ requirements: { ...requirements, source: 'mdm' }, config })).toEqual(open);
    expect(classifyCodexPolicy({ requirements: { requirements: null, source: 'none' }, config: layers() })).toEqual({
      ...open,
      managedPolicy: false,
    });
  });

  test('requirements that leave out a field that says who answers reserve approvals, and still restrict the rest', () => {
    for (const field of ['allowedApprovalsReviewers', 'allowedApprovalPolicies']) {
      expect({ field, result: classifyCodexPolicy({ requirements: without(field), config }) }).toEqual({
        field,
        result: unread,
      });
    }
    // The sandbox modes are optional, and what the answer says about them still holds.
    expect(classifyCodexPolicy({ requirements: without('allowedSandboxModes'), config })).toEqual({
      managedPolicy: true,
      approvalsReservedToOwner: false,
      problem: null,
    });
    expect(classifyCodexPolicy({ requirements: { requirements: { allowedSandboxModes: ['read-only'] } }, config })).toEqual({
      managedPolicy: true,
      approvalsReservedToOwner: true,
      problem: 'managed policy does not allow workspace-write',
    });
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
