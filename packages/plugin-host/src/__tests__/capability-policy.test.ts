import { describe, expect, it } from 'vitest';
import type { DeclarativeActionAliasV1, DeclarativeWorkflowAliasV1 } from '@openslack/plugin-api';
import {
  assertDeclarativeAlias,
  computeEffectiveCapabilities,
  createHostTargetCatalog,
  isForbiddenMappingName,
  validateContributionCapabilities,
  validateDeclarativeAlias,
  type HostActionTargetFacts,
  type HostWorkflowTargetFacts,
} from '../capability-policy.js';
import { PluginHostError } from '../findings.js';

function actionTarget(overrides: Partial<HostActionTargetFacts> = {}): HostActionTargetFacts {
  return {
    kind: 'host_action',
    id: 'pr.status',
    exists: true,
    declarativeAliasAllowed: true,
    sideEffects: false,
    risk: 'none',
    confirmationRequired: false,
    exposesSecrets: false,
    exposesCredentials: false,
    exposesPaths: false,
    requiredCapability: 'host.actions.read',
    inputSchema: { prNumber: { type: 'number', required: true } },
    ...overrides,
  };
}

function workflowTarget(overrides: Partial<HostWorkflowTargetFacts> = {}): HostWorkflowTargetFacts {
  return {
    kind: 'host_workflow',
    id: 'profile.status',
    exists: true,
    declarativeAliasAllowed: true,
    sideEffects: false,
    risk: 'none',
    confirmationRequired: false,
    exposesSecrets: false,
    exposesCredentials: false,
    exposesPaths: false,
    inputSchema: {},
    ...overrides,
  };
}

function actionAlias(): DeclarativeActionAliasV1 {
  return {
    kind: 'action_alias',
    id: 'show-pr',
    target: { kind: 'host_action', id: 'pr.status' },
    inputs: { prNumber: { type: 'number', required: true } },
    inputMapping: { prNumber: { kind: 'input', name: 'prNumber' } },
  };
}

describe('computeEffectiveCapabilities', () => {
  it('computes requested intersection hostAllowed intersection actorAllowed in ASCII order', () => {
    const result = computeEffectiveCapabilities({
      providerKind: 'declarative',
      pluginId: 'reader',
      requestedCapabilities: ['workspace.read', 'host.actions.read'],
      hostAllowedCapabilities: ['host.actions.read', 'workspace.read'],
      actorAllowedCapabilities: ['workspace.read', 'host.actions.read'],
    });
    expect(result.effectiveCapabilities).toEqual(['host.actions.read', 'workspace.read']);
    expect(result.deniedFindings).toEqual([]);
    expect(Object.isFrozen(result.effectiveCapabilities)).toBe(true);
  });

  it('independently hard-denies unknown, executable, and merge-request capabilities', () => {
    const result = computeEffectiveCapabilities({
      providerKind: 'bundled',
      requestedCapabilities: [
        'host.actions.plan',
        'github.pull_requests.merge.request',
        'github.pull_requests.approve',
      ],
      hostAllowedCapabilities: [
        'host.actions.plan',
        'github.pull_requests.merge.request',
        'github.pull_requests.approve',
      ],
      actorAllowedCapabilities: [
        'host.actions.plan',
        'github.pull_requests.merge.request',
        'github.pull_requests.approve',
      ],
    });
    expect(result.effectiveCapabilities).toEqual(['host.actions.plan']);
    expect(result.deniedFindings.map((finding) => finding.code)).toEqual([
      'PLUGIN_CAPABILITY_HARD_DENIED',
      'PLUGIN_CAPABILITY_UNKNOWN',
    ]);
  });

  it('does not turn host or actor denial into an effective capability', () => {
    const result = computeEffectiveCapabilities({
      providerKind: 'declarative',
      requestedCapabilities: ['host.actions.read', 'workspace.read'],
      hostAllowedCapabilities: ['host.actions.read'],
      actorAllowedCapabilities: ['workspace.read'],
    });
    expect(result.effectiveCapabilities).toEqual([]);
    expect(result.deniedFindings.map((finding) => finding.code).sort()).toEqual([
      'PLUGIN_CAPABILITY_ACTOR_DENIED',
      'PLUGIN_CAPABILITY_HOST_DENIED',
    ]);
  });

  it('rejects duplicate requests instead of silently granting first-wins authority', () => {
    const result = computeEffectiveCapabilities({
      providerKind: 'declarative',
      requestedCapabilities: ['host.actions.read', 'host.actions.read'],
      hostAllowedCapabilities: ['host.actions.read'],
      actorAllowedCapabilities: ['host.actions.read'],
    });
    expect(result.effectiveCapabilities).toEqual(['host.actions.read']);
    expect(result.deniedFindings[0]?.code).toBe('PLUGIN_CAPABILITY_DUPLICATE');
  });
});

describe('contribution capability ceiling', () => {
  it('requires the host read capability matching each declarative alias kind', () => {
    const findings = validateContributionCapabilities(
      [
        actionAlias(),
        {
          kind: 'workflow_alias',
          id: 'profile',
          target: { kind: 'host_workflow', id: 'profile.status' },
        },
      ],
      ['host.actions.read'],
      'reader',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('PLUGIN_CONTRIBUTION_CAPABILITY_MISSING');
    expect(findings[0]?.contributionId).toBe('profile');
  });

  it('rejects PRMS and executable contribution kinds despite permissive casts', () => {
    const findings = validateContributionCapabilities(
      [
        { kind: 'prms_blocker', id: 'fake-pass' },
        { kind: 'command', id: 'shell' },
      ],
      ['host.actions.read', 'host.workflows.read'],
      'unsafe',
    );
    expect(findings.map((finding) => finding.code)).toEqual([
      'PLUGIN_ALIAS_TARGET_FORBIDDEN',
      'PLUGIN_ALIAS_TARGET_FORBIDDEN',
    ]);
  });
});

describe('declarative alias target validation', () => {
  it('resolves a scalar-only alias of a catalogued side-effect-free action', () => {
    const catalog = createHostTargetCatalog({ actions: [actionTarget()] });
    const result = validateDeclarativeAlias(actionAlias(), catalog, 'reader');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.resolved.target.id).toBe('pr.status');
      expect(Object.isFrozen(result.resolved.target)).toBe(true);
      expect(Object.isFrozen(result.resolved.target.inputSchema)).toBe(true);
    }
  });

  it.each([
    { sideEffects: true },
    { risk: 'low' as const },
    { confirmationRequired: true },
    { declarativeAliasAllowed: false },
    { exposesSecrets: true },
    { exposesCredentials: true },
    { exposesPaths: true },
  ])('rejects unsafe target facts %#', (override) => {
    const catalog = createHostTargetCatalog({ actions: [actionTarget(override)] });
    const result = validateDeclarativeAlias(actionAlias(), catalog, 'reader');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.findings[0]?.code).toBe('PLUGIN_ALIAS_TARGET_UNSAFE');
  });

  it('rejects missing targets and cross-kind target references', () => {
    const catalog = createHostTargetCatalog({
      actions: [actionTarget()],
      workflows: [workflowTarget()],
    });
    const missing = validateDeclarativeAlias(
      { ...actionAlias(), target: { kind: 'host_action', id: 'missing' } },
      catalog,
    );
    expect(missing.valid).toBe(false);
    if (!missing.valid) expect(missing.findings[0]?.code).toBe('PLUGIN_ALIAS_TARGET_NOT_FOUND');

    const crossKind = validateDeclarativeAlias(
      {
        kind: 'action_alias',
        id: 'wrong-kind',
        target: { kind: 'host_workflow', id: 'profile.status' },
      },
      catalog,
    );
    expect(crossKind.valid).toBe(false);
  });

  it('accepts a pre-registered read-only workflow catalog alias', () => {
    const contribution: DeclarativeWorkflowAliasV1 = {
      kind: 'workflow_alias',
      id: 'profile',
      target: { kind: 'host_workflow', id: 'profile.status' },
    };
    const resolved = assertDeclarativeAlias(
      contribution,
      createHostTargetCatalog({ workflows: [workflowTarget()] }),
    );
    expect(resolved.kind).toBe('workflow_alias');
  });

  it('cross-validates required fields, scalar types, and pass-through input requirements', () => {
    const catalog = createHostTargetCatalog({ actions: [actionTarget()] });
    const missing = validateDeclarativeAlias({ ...actionAlias(), inputMapping: {} }, catalog);
    expect(missing.valid).toBe(false);
    if (!missing.valid) {
      expect(
        missing.findings.some(
          (finding) => finding.code === 'PLUGIN_ALIAS_MAPPING_REQUIRED_TARGET_MISSING',
        ),
      ).toBe(true);
    }

    const optionalSource = validateDeclarativeAlias(
      {
        ...actionAlias(),
        inputs: { prNumber: { type: 'number', required: false } },
      },
      catalog,
    );
    expect(optionalSource.valid).toBe(false);
    if (!optionalSource.valid) {
      expect(optionalSource.findings[0]?.code).toBe('PLUGIN_ALIAS_MAPPING_TYPE_MISMATCH');
    }

    const wrongConstant = validateDeclarativeAlias(
      {
        ...actionAlias(),
        inputs: {},
        inputMapping: { prNumber: { kind: 'constant', value: '42' } },
      },
      catalog,
    );
    expect(wrongConstant.valid).toBe(false);
  });

  it('case-folds forbidden names and blocks raw command/path/credential mappings', () => {
    expect(isForbiddenMappingName('ARGV')).toBe(true);
    expect(isForbiddenMappingName('ConfirmationRequired')).toBe(true);
    expect(isForbiddenMappingName('PrivateKey')).toBe(true);

    expect(() =>
      createHostTargetCatalog({
        actions: [actionTarget({ inputSchema: { Command: { type: 'string', required: true } } })],
      }),
    ).toThrowError(PluginHostError);
  });

  it.each(['pr.merge', 'pull-request.approve', 'review.approval.status', 'pr.mergeable'])(
    'hard-denies authority-bearing target identity %s',
    (id) => {
      expect(() => createHostTargetCatalog({ actions: [actionTarget({ id })] })).toThrowError(
        PluginHostError,
      );
    },
  );

  it('requires exact deeply normalized target facts and a known required capability', () => {
    expect(() =>
      createHostTargetCatalog({
        actions: [
          {
            ...actionTarget(),
            requiredCapability: 'github.pull_requests.approve',
          } as unknown as HostActionTargetFacts,
        ],
      }),
    ).toThrowError(PluginHostError);
    expect(() =>
      createHostTargetCatalog({
        actions: [{ ...actionTarget(), extraAuthority: true } as unknown as HostActionTargetFacts],
      }),
    ).toThrowError(PluginHostError);
  });

  it('does not invoke an accessor supplied through a permissive validator substitution', () => {
    let accessed = false;
    const contribution = actionAlias() as unknown as Record<string, unknown>;
    Object.defineProperty(contribution, 'target', {
      enumerable: true,
      get() {
        accessed = true;
        return { kind: 'host_action', id: 'pr.status' };
      },
    });
    const result = validateDeclarativeAlias(
      contribution,
      createHostTargetCatalog({ actions: [actionTarget()] }),
    );
    expect(result.valid).toBe(false);
    expect(accessed).toBe(false);
  });

  it('throws typed findings from the assertion API', () => {
    expect(() =>
      assertDeclarativeAlias(
        actionAlias(),
        createHostTargetCatalog({ actions: [actionTarget({ sideEffects: true })] }),
      ),
    ).toThrow(PluginHostError);
  });
});
