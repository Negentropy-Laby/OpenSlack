import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionAuthorizationRequest,
  ActivationAuthorizationRequest,
  HostPlanStep,
  HostPolicyDecision,
  HostPolicyPort,
  PlanStepValidationRequest,
  PluginAuditEvent,
} from '@openslack/plugin-api';
import { PluginHost, PluginHostError, PluginManifestLoadError, pluginActionId } from '../index.js';
import { serializePluginLock, type PluginLockEntry } from '../lock.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class AllowPolicy implements HostPolicyPort<HostPlanStep> {
  readonly audits: PluginAuditEvent[] = [];
  failAudit = false;

  authorizeActivation(request: ActivationAuthorizationRequest) {
    return {
      outcome: 'allow' as const,
      code: 'PLUGIN_ACTIVATION_ALLOWED' as const,
      reason: 'Test host policy permits the fixture.',
      hostAllowedCapabilities: [...request.requestedCapabilities],
      actorAllowedCapabilities: [...request.requestedCapabilities],
      evidenceRefs: ['policy:test'],
    };
  }

  authorizeAction(_request: ActionAuthorizationRequest): HostPolicyDecision {
    return {
      outcome: 'allow' as const,
      code: 'PLUGIN_ACTION_ALLOWED',
      reason: 'Action is allowed.',
      evidenceRefs: ['policy:action'],
    };
  }

  validatePlanStep(_request: PlanStepValidationRequest<HostPlanStep>): HostPolicyDecision {
    return {
      outcome: 'allow' as const,
      code: 'PLUGIN_PLAN_ALLOWED',
      reason: 'Plan is valid.',
      evidenceRefs: ['policy:plan'],
    };
  }

  recordAuditEvent(event: PluginAuditEvent): void {
    if (this.failAudit) throw new Error('sensitive sink text');
    this.audits.push(event);
  }
}

function manifest(id: string, target = 'status.show', gateMode: 'SHADOW' | 'ENFORCE' = 'ENFORCE') {
  return {
    schema: 'openslack.plugin.v1',
    id,
    version: '1.0.0',
    name: `${id} fixture`,
    requires: { openslack: '>=0.1.0 <1.0.0' },
    gate: { mode: gateMode, gateId: 'host.read-only' },
    capabilities: ['host.actions.read'],
    contributes: [
      {
        kind: 'action_alias',
        id: 'status',
        target: { kind: 'host_action', id: target },
      },
    ],
  };
}

function manifestBytes(value: unknown, spacing = 2): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, spacing)}\n`, 'utf8');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function workspace(entries: readonly { id: string; value: unknown; bytes?: Buffer }[]) {
  const root = await mkdtemp(join(tmpdir(), 'openslack-plugin-host-'));
  roots.push(root);
  const openslack = join(root, '.openslack');
  await mkdir(join(openslack, 'plugins'), { recursive: true });
  const lockEntries: PluginLockEntry[] = [];
  for (const item of entries) {
    const bytes = item.bytes ?? manifestBytes(item.value);
    const directory = join(openslack, 'plugins', item.id);
    await mkdir(directory);
    await writeFile(join(directory, 'plugin.json'), bytes);
    const record = item.value as ReturnType<typeof manifest>;
    lockEntries.push({
      id: item.id,
      version: record.version,
      providerKind: 'workspace',
      sourceRef: `.openslack/plugins/${item.id}/plugin.json`,
      manifestSha256: sha256(bytes),
      requestedGateMode: record.gate.mode,
    });
  }
  await writeFile(
    join(openslack, 'plugins.lock'),
    serializePluginLock({ schema: 'openslack.plugins_lock.v1', plugins: lockEntries }),
  );
  return root;
}

async function installedWorkspace(id: string, value: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'openslack-plugin-host-installed-'));
  roots.push(root);
  const installedRoot = join(root, 'installed', id);
  const openslack = join(root, '.openslack');
  await mkdir(installedRoot, { recursive: true });
  await mkdir(openslack, { recursive: true });
  const bytes = manifestBytes(value);
  await writeFile(join(installedRoot, 'plugin.json'), bytes);
  const record = value as ReturnType<typeof manifest>;
  const sourceRef = `node_modules/${id}/plugin.json`;
  await writeFile(
    join(openslack, 'plugins.lock'),
    serializePluginLock({
      schema: 'openslack.plugins_lock.v1',
      plugins: [
        {
          id,
          version: record.version,
          providerKind: 'plugin',
          sourceRef,
          manifestSha256: sha256(bytes),
          requestedGateMode: record.gate.mode,
        },
      ],
    }),
  );
  return { workspaceRoot: root, installedRoot, sourceRef };
}

function binding() {
  return {
    compositionId: 'openslack.test-composition',
    openslackVersion: '0.1.1',
    gateIds: ['host.read-only', 'host.bundled'],
    targets: {
      actions: [
        {
          kind: 'host_action',
          id: 'status.show',
          exists: true,
          declarativeAliasAllowed: true,
          sideEffects: false,
          risk: 'none',
          confirmationRequired: false,
          exposesSecrets: false,
          exposesCredentials: false,
          exposesPaths: false,
          inputSchema: {},
          requiredCapability: 'host.actions.read' as const,
        },
        {
          kind: 'host_action',
          id: 'repository.write',
          exists: true,
          declarativeAliasAllowed: false,
          sideEffects: true,
          risk: 'high',
          confirmationRequired: true,
          exposesSecrets: false,
          exposesCredentials: false,
          exposesPaths: true,
          inputSchema: {},
          requiredCapability: 'github.issues.write' as const,
        },
      ],
    },
  } as const;
}

function host(
  policy = new AllowPolicy(),
  bundledPlugins: readonly { readonly definition: unknown; readonly evidence: unknown }[] = [],
  operationTimeoutMs?: number,
): { host: PluginHost; policy: AllowPolicy } {
  const value = new PluginHost({
    policy,
    binding: binding(),
    bundledPlugins,
    ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
  });
  return { host: value, policy };
}

function workspaceEvidence(id: string, hash: string) {
  return {
    schema: 'openslack.plugin_activation_evidence.v1',
    plugin: { id, version: '1.0.0' },
    observedAt: '2026-07-16T00:00:00.000Z',
    actor: { id: 'reviewer', kind: 'human', provider: 'github' },
    humanApproval: { required: true, satisfied: true, evidenceRefs: ['review:fixture'] },
    providerKind: 'workspace',
    source: {
      kind: 'locked_manifest',
      sourceRef: `.openslack/plugins/${id}/plugin.json`,
      manifestSha256: hash,
      lockManifestSha256: hash,
      integrityMatched: true,
    },
  };
}

function bundledEvidence(id: string) {
  return {
    schema: 'openslack.plugin_activation_evidence.v1',
    plugin: { id, version: '1.0.0' },
    observedAt: '2026-07-16T00:00:00.000Z',
    actor: { id: 'composition-root', kind: 'system', provider: 'openslack' },
    humanApproval: { required: true, satisfied: true, evidenceRefs: ['review:bundled'] },
    providerKind: 'bundled',
    source: {
      kind: 'bundled',
      compositionId: 'openslack.test-composition',
      reviewEvidenceRefs: ['review:bundled'],
    },
  };
}

function bundledPlugin(evaluate: () => unknown, gateMode: 'SHADOW' | 'ENFORCE' = 'ENFORCE') {
  return {
    providerKind: 'bundled',
    id: 'review-guard',
    version: '1.0.0',
    name: 'Review guard',
    requires: { openslack: '>=0.1.0 <1.0.0' },
    gate: { mode: gateMode, gateId: 'host.bundled' },
    requestedCapabilities: ['prms.blockers.append'],
    contributions: [{ kind: 'prms_blocker', id: 'guard', evaluate }],
  };
}

function bundledActionPlugin(options: {
  readonly buildPlanStep: () => unknown;
  readonly gateMode?: 'SHADOW' | 'ENFORCE';
  readonly activate?: () => unknown;
  readonly deactivate?: () => unknown;
}) {
  return {
    providerKind: 'bundled',
    id: 'action-guard',
    version: '1.0.0',
    name: 'Action guard',
    requires: { openslack: '>=0.1.0 <1.0.0' },
    gate: { mode: options.gateMode ?? 'ENFORCE', gateId: 'host.bundled' },
    requestedCapabilities: ['host.actions.plan', 'host.actions.read'],
    contributions: [
      {
        kind: 'bundled_action',
        id: 'status',
        target: { kind: 'host_action', id: 'status.show' },
        buildPlanStep: options.buildPlanStep,
      },
    ],
    ...(options.activate === undefined ? {} : { activate: options.activate }),
    ...(options.deactivate === undefined ? {} : { deactivate: options.deactivate }),
  };
}

describe('PluginHost integration', () => {
  it('loads, locks, registers, activates, audits, and plans a declarative alias', async () => {
    const value = manifest('observer');
    const bytes = manifestBytes(value);
    const root = await workspace([{ id: 'observer', value, bytes }]);
    const { host: pluginHost, policy } = host();
    const loaded = await pluginHost.loadWorkspacePlugins({ workspaceRoot: root });
    expect(loaded.registered[0]).toMatchObject({
      id: 'observer',
      lifecycle: { state: 'registered' },
    });
    pluginHost.seal();
    await pluginHost.activate('observer', workspaceEvidence('observer', sha256(bytes)));
    const result = await pluginHost.planAction(pluginActionId('observer', 'status'), {});
    expect(result).toMatchObject({
      outcome: 'planned',
      targetActionId: 'status.show',
      executable: true,
      step: { actionId: 'status.show', input: {} },
    });
    expect(policy.audits.map((event) => event.type)).toEqual([
      'plugin.activation.requested',
      'plugin.activation.allowed',
      'plugin.action.requested',
      'plugin.action.allowed',
    ]);
  });

  it('invalidates a lock on whitespace-only byte changes without partial registration', async () => {
    const value = manifest('observer');
    const original = manifestBytes(value, 2);
    const root = await workspace([{ id: 'observer', value, bytes: original }]);
    await writeFile(
      join(root, '.openslack', 'plugins', 'observer', 'plugin.json'),
      manifestBytes(value, 0),
    );
    const { host: pluginHost } = host();
    await expect(pluginHost.loadWorkspacePlugins({ workspaceRoot: root })).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_HOST_LOCK_HASH_MISMATCH' }],
    });
    expect(pluginHost.snapshot()).toMatchObject({ registryRevision: 0, plugins: [] });
  });

  it('does not commit a workspace registration when the host seals during async loading', async () => {
    const value = manifest('observer');
    const root = await workspace([{ id: 'observer', value }]);
    const pluginHost = host().host;
    const pending = pluginHost.loadWorkspacePlugins({ workspaceRoot: root });
    pluginHost.seal();
    await expect(pending).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_HOST_SEALED' }],
    });
    expect(pluginHost.snapshot()).toMatchObject({ registryRevision: 0, plugins: [] });
  });

  it('does not commit an installed registration when the host seals during async loading', async () => {
    const value = manifest('observer');
    const installed = await installedWorkspace('observer', value);
    const pluginHost = host().host;
    const pending = pluginHost.loadInstalledPlugin({
      workspaceRoot: installed.workspaceRoot,
      installedRoot: installed.installedRoot,
      pluginId: 'observer',
    });
    pluginHost.seal();
    await expect(pending).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_HOST_SEALED' }],
    });
    expect(pluginHost.snapshot()).toMatchObject({ registryRevision: 0, plugins: [] });
  });

  it('rejects permissive-validator bypass fields and mutating targets atomically', async () => {
    const executable = { ...manifest('safe'), entry: './side-effect.js' };
    const root = await workspace([
      { id: 'safe', value: executable },
      { id: 'unsafe', value: manifest('unsafe', 'repository.write') },
    ]);
    const { host: pluginHost } = host();
    await expect(pluginHost.loadWorkspacePlugins({ workspaceRoot: root })).rejects.toBeInstanceOf(
      PluginManifestLoadError,
    );
    expect(pluginHost.snapshot().plugins).toEqual([]);

    const secondRoot = await workspace([
      { id: 'safe', value: manifest('safe') },
      { id: 'unsafe', value: manifest('unsafe', 'repository.write') },
    ]);
    const second = host().host;
    await expect(second.loadWorkspacePlugins({ workspaceRoot: secondRoot })).rejects.toBeInstanceOf(
      PluginHostError,
    );
    expect(second.snapshot().plugins).toEqual([]);
  });

  it('requires matching activation evidence and a sealed host', async () => {
    const value = manifest('observer');
    const bytes = manifestBytes(value);
    const root = await workspace([{ id: 'observer', value, bytes }]);
    const { host: pluginHost } = host();
    await pluginHost.loadWorkspacePlugins({ workspaceRoot: root });
    await expect(
      pluginHost.activate('observer', workspaceEvidence('observer', sha256(bytes))),
    ).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_HOST_NOT_SEALED' }],
    });
    pluginHost.seal();
    await expect(pluginHost.activate('observer', undefined)).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISSING' }],
    });
    const forged = workspaceEvidence('observer', sha256(bytes));
    forged.source.manifestSha256 = 'b'.repeat(64);
    await expect(pluginHost.activate('observer', forged)).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISMATCH' }],
    });
  });

  it('has instance-local registries and no rebind or force escape', async () => {
    const value = manifest('observer');
    const root = await workspace([{ id: 'observer', value }]);
    const first = host().host;
    const second = host().host;
    await first.loadWorkspacePlugins({ workspaceRoot: root });
    expect(first.snapshot().plugins).toHaveLength(1);
    expect(second.snapshot().plugins).toHaveLength(0);
    expect('bind' in first).toBe(false);
    expect('registerBundledPlugin' in first).toBe(false);
    first.seal();
    await expect(first.loadWorkspacePlugins({ workspaceRoot: root })).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_HOST_SEALED' }],
    });
  });

  it('fails closed before state mutation when a required allow audit cannot persist', async () => {
    const value = manifest('observer');
    const bytes = manifestBytes(value);
    const root = await workspace([{ id: 'observer', value, bytes }]);
    const setup = host();
    await setup.host.loadWorkspacePlugins({ workspaceRoot: root });
    setup.host.seal();
    setup.policy.failAudit = true;
    await expect(
      setup.host.activate('observer', workspaceEvidence('observer', sha256(bytes))),
    ).rejects.toMatchObject({ findings: [{ code: 'PLUGIN_AUDIT_WRITE_FAILED' }] });
    expect(setup.host.snapshot().plugins[0]?.lifecycle.state).toBe('registered');
  });

  it('keeps bundled provider elevation explicit and normalizes PRMS to blockers only', async () => {
    const definition = bundledPlugin(() => ({
      blockers: [{ kind: 'blocker', code: 'REVIEW_GUARD', summary: 'Guarded.' }],
    }));
    const evidence = bundledEvidence('review-guard');
    expect(() => host(new AllowPolicy(), [{ definition, evidence: undefined }])).toThrowError(
      PluginHostError,
    );
    const setup = host(new AllowPolicy(), [{ definition, evidence }]);
    setup.host.seal();
    await setup.host.activate('review-guard', evidence);
    await expect(setup.host.evaluatePrmsBlockers({})).resolves.toEqual({
      blockers: [{ kind: 'blocker', code: 'REVIEW_GUARD', summary: 'Guarded.' }],
    });
  });

  it.each([
    () => ({ blockers: [], outcome: 'PASS' }),
    () => ({ blockers: [], approvalCount: 99 }),
    () => ({ blockers: [], mergeable: true }),
    () => {
      throw new Error('evaluator secret');
    },
  ])('turns malformed or failed bundled PRMS evaluation into a host blocker', async (evaluate) => {
    const evidence = bundledEvidence('review-guard');
    const setup = host(new AllowPolicy(), [{ definition: bundledPlugin(evaluate), evidence }]);
    setup.host.seal();
    await setup.host.activate('review-guard', evidence);
    const result = await setup.host.evaluatePrmsBlockers({});
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.kind).toBe('blocker');
    expect(result.blockers[0]?.code).toMatch(/PLUGIN_HOST_PRMS_(RESULT_INVALID|EVALUATOR_FAILED)/);
    expect(result).not.toHaveProperty('outcome');
  });

  it('never enforces SHADOW PRMS blockers', async () => {
    const evidence = bundledEvidence('review-guard');
    const evaluator = vi.fn(() => ({
      blockers: [{ kind: 'blocker', code: 'SHOULD_NOT_RUN', summary: 'No.' }],
    }));
    const setup = host(new AllowPolicy(), [
      { definition: bundledPlugin(evaluator, 'SHADOW'), evidence },
    ]);
    setup.host.seal();
    await setup.host.activate('review-guard', evidence);
    await expect(setup.host.evaluatePrmsBlockers({})).resolves.toEqual({ blockers: [] });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it('keeps SHADOW hooks and builders completely inert', async () => {
    const activate = vi.fn();
    const deactivate = vi.fn();
    const buildPlanStep = vi.fn(() => ({ id: 'status.step', actionId: 'status.show', input: {} }));
    const evidence = bundledEvidence('action-guard');
    const setup = host(new AllowPolicy(), [
      {
        definition: bundledActionPlugin({
          gateMode: 'SHADOW',
          activate,
          deactivate,
          buildPlanStep,
        }),
        evidence,
      },
    ]);
    setup.host.seal();
    await setup.host.activate('action-guard', evidence);
    await expect(
      setup.host.planAction(pluginActionId('action-guard', 'status'), {}),
    ).resolves.toEqual({
      outcome: 'shadowed',
      contributedActionId: pluginActionId('action-guard', 'status'),
      targetActionId: 'status.show',
      executable: false,
    });
    await setup.host.deactivate('action-guard');
    expect(activate).not.toHaveBeenCalled();
    expect(buildPlanStep).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
  });

  it('serializes activation per plugin before the first await and releases the gate', async () => {
    let releaseActivation!: () => void;
    const activate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseActivation = resolve;
        }),
    );
    const buildPlanStep = vi.fn(() => ({ id: 'status.step', actionId: 'status.show', input: {} }));
    const evidence = bundledEvidence('action-guard');
    const setup = host(new AllowPolicy(), [
      { definition: bundledActionPlugin({ activate, buildPlanStep }), evidence },
    ]);
    setup.host.seal();

    const first = setup.host.activate('action-guard', evidence);
    await expect(setup.host.activate('action-guard', evidence)).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_LIFECYCLE_INVALID_TRANSITION' }],
    });
    await expect(
      setup.host.planAction(pluginActionId('action-guard', 'status'), {}),
    ).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_LIFECYCLE_INVALID_TRANSITION' }],
    });
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    releaseActivation();
    await expect(first).resolves.toMatchObject({ lifecycle: { state: 'activated' } });
    expect(activate).toHaveBeenCalledTimes(1);
    await expect(
      setup.host.planAction(pluginActionId('action-guard', 'status'), {}),
    ).resolves.toMatchObject({ outcome: 'planned' });
  });

  it('serializes deactivation and blocks action and PRMS execution during its hook window', async () => {
    let releaseDeactivation!: () => void;
    const deactivate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDeactivation = resolve;
        }),
    );
    const buildPlanStep = vi.fn(() => ({ id: 'status.step', actionId: 'status.show', input: {} }));
    const evaluator = vi.fn(() => ({ blockers: [] }));
    const base = bundledActionPlugin({ deactivate, buildPlanStep });
    const definition = {
      ...base,
      requestedCapabilities: [...base.requestedCapabilities, 'prms.blockers.append'],
      contributions: [
        ...base.contributions,
        { kind: 'prms_blocker', id: 'guard', evaluate: evaluator },
      ],
    };
    const evidence = bundledEvidence('action-guard');
    const setup = host(new AllowPolicy(), [{ definition, evidence }]);
    setup.host.seal();
    await setup.host.activate('action-guard', evidence);

    const first = setup.host.deactivate('action-guard');
    await expect(setup.host.deactivate('action-guard')).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_LIFECYCLE_INVALID_TRANSITION' }],
    });
    await expect(
      setup.host.planAction(pluginActionId('action-guard', 'status'), {}),
    ).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_LIFECYCLE_INVALID_TRANSITION' }],
    });
    await expect(setup.host.evaluatePrmsBlockers({})).resolves.toMatchObject({
      blockers: [{ code: 'PLUGIN_HOST_PRMS_EVALUATOR_FAILED' }],
    });
    expect(buildPlanStep).not.toHaveBeenCalled();
    expect(evaluator).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    releaseDeactivation();
    await expect(first).resolves.toMatchObject({ lifecycle: { state: 'disabled' } });
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('authorizes the sealed target before invoking a builder and audits fixed-target mismatch', async () => {
    const order: string[] = [];
    const buildPlanStep = vi.fn(() => {
      order.push('builder');
      return { id: 'status.step', actionId: 'repository.write', input: {} };
    });
    const evidence = bundledEvidence('action-guard');
    const setup = host(new AllowPolicy(), [
      { definition: bundledActionPlugin({ buildPlanStep }), evidence },
    ]);
    vi.spyOn(setup.policy, 'authorizeAction').mockImplementation((request) => {
      order.push(`authorize:${request.target.id}`);
      return {
        outcome: 'allow',
        code: 'PLUGIN_ACTION_ALLOWED',
        reason: 'Allowed.',
        evidenceRefs: ['policy:action'],
      };
    });
    setup.host.seal();
    await setup.host.activate('action-guard', evidence);
    await expect(
      setup.host.planAction(pluginActionId('action-guard', 'status'), {}),
    ).rejects.toMatchObject({ findings: [{ code: 'PLUGIN_HOST_PLAN_STEP_INVALID' }] });
    expect(order).toEqual(['authorize:status.show', 'builder']);
    expect(setup.policy.audits.at(-1)).toMatchObject({
      type: 'plugin.action.denied',
      metadata: { decisionCode: 'fixed_target_mismatch' },
    });
  });

  it('does not invoke a builder when action policy denies and records the denial', async () => {
    const buildPlanStep = vi.fn();
    const evidence = bundledEvidence('action-guard');
    const setup = host(new AllowPolicy(), [
      { definition: bundledActionPlugin({ buildPlanStep }), evidence },
    ]);
    vi.spyOn(setup.policy, 'authorizeAction').mockReturnValue({
      outcome: 'deny',
      code: 'TEST_ACTION_DENIED',
      reason: 'Denied.',
      evidenceRefs: ['policy:denied'],
    });
    setup.host.seal();
    await setup.host.activate('action-guard', evidence);
    await expect(
      setup.host.planAction(pluginActionId('action-guard', 'status'), {}),
    ).rejects.toMatchObject({ findings: [{ code: 'PLUGIN_HOST_ACTION_DENIED' }] });
    expect(buildPlanStep).not.toHaveBeenCalled();
    expect(setup.policy.audits.slice(-2).map((event) => event.type)).toEqual([
      'plugin.action.requested',
      'plugin.action.denied',
    ]);
  });

  it('bounds builders and evaluator execution with host-owned deadlines', async () => {
    const never = () => new Promise<never>(() => undefined);
    const actionEvidence = bundledEvidence('action-guard');
    const actionSetup = host(
      new AllowPolicy(),
      [{ definition: bundledActionPlugin({ buildPlanStep: never }), evidence: actionEvidence }],
      5,
    );
    actionSetup.host.seal();
    await actionSetup.host.activate('action-guard', actionEvidence);
    await expect(
      actionSetup.host.planAction(pluginActionId('action-guard', 'status'), {}),
    ).rejects.toMatchObject({ findings: [{ code: 'PLUGIN_HOST_PLAN_STEP_INVALID' }] });
    expect(actionSetup.policy.audits.at(-1)?.type).toBe('plugin.action.denied');

    const evaluatorEvidence = bundledEvidence('review-guard');
    const evaluatorSetup = host(
      new AllowPolicy(),
      [{ definition: bundledPlugin(never), evidence: evaluatorEvidence }],
      5,
    );
    evaluatorSetup.host.seal();
    await evaluatorSetup.host.activate('review-guard', evaluatorEvidence);
    await expect(evaluatorSetup.host.evaluatePrmsBlockers({})).resolves.toMatchObject({
      blockers: [{ code: 'PLUGIN_HOST_PRMS_EVALUATOR_FAILED' }],
    });
  });

  it('makes failed activation and deactivation hooks non-repeatable and audits actual state', async () => {
    const failingActivate = vi.fn(() => new Promise<never>(() => undefined));
    const activationEvidence = bundledEvidence('action-guard');
    const activationSetup = host(
      new AllowPolicy(),
      [
        {
          definition: bundledActionPlugin({ buildPlanStep: vi.fn(), activate: failingActivate }),
          evidence: activationEvidence,
        },
      ],
      5,
    );
    activationSetup.host.seal();
    await expect(
      activationSetup.host.activate('action-guard', activationEvidence),
    ).rejects.toMatchObject({ findings: [{ code: 'PLUGIN_HOST_ACTIVATION_HOOK_FAILED' }] });
    expect(activationSetup.host.snapshot().plugins[0]?.lifecycle.state).toBe('disabled');
    await expect(
      activationSetup.host.activate('action-guard', activationEvidence),
    ).rejects.toMatchObject({ findings: [{ code: 'PLUGIN_LIFECYCLE_INVALID_TRANSITION' }] });
    expect(failingActivate).toHaveBeenCalledTimes(1);
    expect(activationSetup.policy.audits.at(-1)).toMatchObject({
      type: 'plugin.lifecycle.changed',
      metadata: { lifecycleFrom: 'registered', lifecycleTo: 'disabled' },
    });

    const failingDeactivate = vi.fn(() => {
      throw new Error('deactivation side effect may have happened');
    });
    const deactivationEvidence = bundledEvidence('action-guard');
    const deactivationSetup = host(new AllowPolicy(), [
      {
        definition: bundledActionPlugin({
          buildPlanStep: vi.fn(),
          deactivate: failingDeactivate,
        }),
        evidence: deactivationEvidence,
      },
    ]);
    deactivationSetup.host.seal();
    await deactivationSetup.host.activate('action-guard', deactivationEvidence);
    await expect(deactivationSetup.host.deactivate('action-guard')).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_HOST_ACTIVATION_HOOK_FAILED' }],
    });
    expect(deactivationSetup.host.snapshot().plugins[0]?.lifecycle.state).toBe('disabled');
    await expect(deactivationSetup.host.deactivate('action-guard')).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_LIFECYCLE_INVALID_TRANSITION' }],
    });
    expect(failingDeactivate).toHaveBeenCalledTimes(1);
    expect(deactivationSetup.policy.audits.at(-1)).toMatchObject({
      type: 'plugin.lifecycle.changed',
      metadata: { lifecycleFrom: 'activated', lifecycleTo: 'disabled' },
    });
  });

  it('audits plan-policy denial and projects a fresh frozen PRMS report per evaluator', async () => {
    const actionEvidence = bundledEvidence('action-guard');
    const actionSetup = host(new AllowPolicy(), [
      {
        definition: bundledActionPlugin({
          buildPlanStep: () => ({ id: 'status.step', actionId: 'status.show', input: {} }),
        }),
        evidence: actionEvidence,
      },
    ]);
    vi.spyOn(actionSetup.policy, 'validatePlanStep').mockReturnValue({
      outcome: 'deny',
      code: 'TEST_PLAN_DENIED',
      reason: 'Denied.',
      evidenceRefs: ['policy:plan-denied'],
    });
    actionSetup.host.seal();
    await actionSetup.host.activate('action-guard', actionEvidence);
    await expect(
      actionSetup.host.planAction(pluginActionId('action-guard', 'status'), {}),
    ).rejects.toMatchObject({ findings: [{ code: 'PLUGIN_HOST_ACTION_DENIED' }] });
    expect(actionSetup.policy.audits.at(-1)).toMatchObject({
      type: 'plugin.action.denied',
      metadata: { decisionCode: 'TEST_PLAN_DENIED' },
    });

    const reports: unknown[] = [];
    const firstEvidence = bundledEvidence('review-guard');
    const secondEvidence = {
      ...bundledEvidence('review-guard'),
      plugin: { id: 'review-guard-two', version: '1.0.0' },
    };
    const secondDefinition = {
      ...bundledPlugin((report?: unknown) => {
        reports.push(report);
        return { blockers: [] };
      }),
      id: 'review-guard-two',
    };
    const firstDefinition = bundledPlugin((report?: unknown) => {
      reports.push(report);
      return { blockers: [] };
    });
    const prmsSetup = host(new AllowPolicy(), [
      { definition: firstDefinition, evidence: firstEvidence },
      { definition: secondDefinition, evidence: secondEvidence },
    ]);
    prmsSetup.host.seal();
    await prmsSetup.host.activate('review-guard', firstEvidence);
    await prmsSetup.host.activate('review-guard-two', secondEvidence);
    const callerReport = { nested: { status: 'pending' } };
    await expect(prmsSetup.host.evaluatePrmsBlockers(callerReport)).resolves.toEqual({
      blockers: [],
    });
    expect(reports).toHaveLength(2);
    expect(reports[0]).not.toBe(reports[1]);
    expect(Object.isFrozen(reports[0])).toBe(true);
    expect(Object.isFrozen((reports[0] as { nested: object }).nested)).toBe(true);
    expect(callerReport).toEqual({ nested: { status: 'pending' } });
  });
});
