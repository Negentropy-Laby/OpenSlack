import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ActionAuthorizationRequest,
  ActivationAuthorizationDecision,
  ActivationAuthorizationRequest,
  ActivationEvidence,
  HostPlanStep,
  HostPolicyDecision,
  HostPolicyPort,
  PlanStepValidationRequest,
  PluginAuditEvent,
  PluginCapability,
} from '@openslack/plugin-api';
import { pluginActionId, serializePluginLock } from '@openslack/plugin-host';
import type {
  ActionRegistryPort,
  ConversationStoreAdapter,
  ExecutionResult,
} from '@openslack/operator';

import { createOpenSlackCliContext, createWorkspacePluginOpenSlackCliContext } from '../context.js';
import { createPluginActionRunner, PluginActionRoutingError } from '../plugin-action-runner.js';
import {
  BUNDLED_METRICS_FIXTURE_ACTION_ID,
  BUNDLED_METRICS_FIXTURE_ID,
  createBundledMetricsFixture,
} from './fixtures/bundled-metrics-enforce.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function conversationAdapter(): ConversationStoreAdapter {
  return {
    listThreads: () => [],
    getThread: () => null,
    appendMessage: (threadId) => ({ messageId: 'message', threadId }),
  };
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

class FixturePolicy implements HostPolicyPort<HostPlanStep> {
  readonly audits: PluginAuditEvent[] = [];
  readonly activationRequests: ActivationAuthorizationRequest[] = [];
  readonly actionRequests: ActionAuthorizationRequest[] = [];
  readonly planRequests: PlanStepValidationRequest<HostPlanStep>[] = [];
  denyAction = false;
  denyPlan = false;

  authorizeActivation(request: ActivationAuthorizationRequest): ActivationAuthorizationDecision {
    this.activationRequests.push(request);
    const allowed: readonly PluginCapability[] =
      request.evidence.plugin.id === 'metrics-shadow'
        ? (['host.actions.read', 'github.issues.read'] as const)
        : (['host.actions.plan', 'github.issues.read'] as const);
    if (!sameValues(request.requestedCapabilities, allowed)) {
      return {
        outcome: 'deny' as const,
        code: 'TEST_ACTIVATION_DENIED',
        reason: 'Fixture capability mismatch.',
        evidenceRefs: [],
      };
    }
    return {
      outcome: 'allow' as const,
      code: 'PLUGIN_ACTIVATION_ALLOWED' as const,
      reason: 'Only the reviewed metrics fixture is allowed.',
      hostAllowedCapabilities: allowed,
      actorAllowedCapabilities: allowed,
      evidenceRefs: ['test-policy:activation'],
    };
  }

  authorizeAction(request: ActionAuthorizationRequest): HostPolicyDecision {
    this.actionRequests.push(request);
    if (
      this.denyAction ||
      request.target.id !== 'github.metrics' ||
      request.target.sideEffects ||
      request.target.risk !== 'none' ||
      request.target.confirmationRequired
    ) {
      return {
        outcome: 'deny',
        code: 'TEST_ACTION_DENIED',
        reason: 'Only github.metrics is allowed.',
        evidenceRefs: [],
      };
    }
    return {
      outcome: 'allow',
      code: 'TEST_ACTION_ALLOWED',
      reason: 'The audited read-only metrics target is allowed.',
      evidenceRefs: ['test-policy:action'],
    };
  }

  validatePlanStep(request: PlanStepValidationRequest<HostPlanStep>): HostPolicyDecision {
    this.planRequests.push(request);
    const valid =
      !this.denyPlan &&
      request.step.actionId === 'github.metrics' &&
      Object.keys(request.step.input).length === 0;
    return valid
      ? {
          outcome: 'allow',
          code: 'TEST_PLAN_ALLOWED',
          reason: 'The minimal metrics plan is allowed.',
          evidenceRefs: ['test-policy:plan'],
        }
      : {
          outcome: 'deny',
          code: 'TEST_PLAN_DENIED',
          reason: 'The plan changed the fixed metrics target.',
          evidenceRefs: [],
        };
  }

  recordAuditEvent(event: PluginAuditEvent): void {
    this.audits.push(event);
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function workspaceFixture(): Promise<{
  readonly root: string;
  readonly evidence: ActivationEvidence;
}> {
  const root = await mkdtemp(join(tmpdir(), 'openslack-p2-pr3-workspace-'));
  roots.push(root);
  const bytes = await readFile(
    new URL('./fixtures/workspace-metrics-shadow/plugin.json', import.meta.url),
  );
  const pluginDirectory = join(root, '.openslack', 'plugins', 'metrics-shadow');
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, 'plugin.json'), bytes);
  const hash = sha256(bytes);
  await writeFile(
    join(root, '.openslack', 'plugins.lock'),
    serializePluginLock({
      schema: 'openslack.plugins_lock.v1',
      plugins: [
        {
          id: 'metrics-shadow',
          version: '1.0.0',
          providerKind: 'workspace',
          sourceRef: '.openslack/plugins/metrics-shadow/plugin.json',
          manifestSha256: hash,
          requestedGateMode: 'SHADOW',
        },
      ],
    }),
  );

  return {
    root,
    evidence: {
      schema: 'openslack.plugin_activation_evidence.v1',
      plugin: { id: 'metrics-shadow', version: '1.0.0' },
      observedAt: '2026-07-16T00:00:00.000Z',
      actor: { id: 'p2-pr3-test', kind: 'application', provider: 'openslack' },
      humanApproval: { required: false, satisfied: false, evidenceRefs: [] },
      providerKind: 'workspace',
      source: {
        kind: 'locked_manifest',
        sourceRef: '.openslack/plugins/metrics-shadow/plugin.json',
        manifestSha256: hash,
        lockManifestSha256: hash,
        integrityMatched: true,
      },
    },
  };
}

function successfulExecution(output = 'Ready: 3'): ExecutionResult {
  return {
    planId: 'PLAN-P2-PR3',
    status: 'success',
    steps: [{ stepId: 'metrics-enforce.ready-count', status: 'success', output, exitCode: 0 }],
    summary: 'Completed metrics proof.',
    nextActions: [],
  };
}

describe('CLI plugin action runner', () => {
  it('loads a workspace alias before seal and exposes SHADOW without execution', async () => {
    const fixture = await workspaceFixture();
    const policy = new FixturePolicy();
    const context = await createWorkspacePluginOpenSlackCliContext({
      workspaceRoot: fixture.root,
      openslackVersion: '0.1.1',
      pluginPolicy: policy,
      conversationStoreAdapter: conversationAdapter(),
      resolvePluginActivationEvidence: async (pluginId) =>
        pluginId === 'metrics-shadow' ? fixture.evidence : undefined,
    });
    const execute = vi.fn(async () => successfulExecution());
    const runner = createPluginActionRunner({
      host: context.pluginHost,
      actionRegistry: context.operator.actionRegistry,
      resolveActivationEvidence: (pluginId) =>
        pluginId === 'metrics-shadow' ? fixture.evidence : undefined,
      execute,
    });

    expect(context.pluginHost.snapshot()).toMatchObject({
      sealed: true,
      actionIds: [pluginActionId('metrics-shadow', 'ready-count')],
    });
    await expect(runner.run('metrics-shadow', 'ready-count')).resolves.toEqual({
      outcome: 'shadowed',
      contributedActionId: pluginActionId('metrics-shadow', 'ready-count'),
      targetActionId: 'github.metrics',
      executable: false,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(policy.planRequests).toHaveLength(0);
    expect(policy.audits.map((event) => event.type)).toEqual([
      'plugin.activation.requested',
      'plugin.activation.allowed',
      'plugin.action.requested',
      'plugin.action.allowed',
    ]);
    expect(policy.audits.at(-1)?.metadata).toMatchObject({ outcome: 'shadowed' });
  });

  it('routes an explicitly registered bundled ENFORCE fixture through the canonical registry', async () => {
    const buildPlanStep = vi.fn(() => ({
      id: 'metrics-enforce.ready-count',
      actionId: 'github.metrics',
      input: {},
    }));
    const fixture = createBundledMetricsFixture(buildPlanStep);
    const policy = new FixturePolicy();
    const context = createOpenSlackCliContext({
      workspaceRoot: '.',
      openslackVersion: '0.1.1',
      pluginPolicy: policy,
      conversationStoreAdapter: conversationAdapter(),
      bundledPlugins: [fixture.registration],
      resolvePluginActivationEvidence: (pluginId) =>
        pluginId === BUNDLED_METRICS_FIXTURE_ID ? fixture.evidence : undefined,
    });
    const execute = vi.fn(async (plan, registry) => {
      expect(registry).toBe(context.operator.actionRegistry);
      expect(plan.steps).toEqual([
        {
          id: 'metrics-enforce.ready-count',
          actionId: 'github.metrics',
          input: {},
          tool: 'openslack-cli',
          command: 'github',
          args: ['metrics'],
          description: 'Show task loop metrics',
          confirmationRequired: false,
        },
      ]);
      return successfulExecution();
    });
    const runner = createPluginActionRunner({
      host: context.pluginHost,
      actionRegistry: context.operator.actionRegistry,
      resolveActivationEvidence: () => fixture.evidence,
      execute,
    });

    await expect(
      runner.run(BUNDLED_METRICS_FIXTURE_ID, BUNDLED_METRICS_FIXTURE_ACTION_ID),
    ).resolves.toMatchObject({
      outcome: 'executed',
      contributedActionId: pluginActionId(
        BUNDLED_METRICS_FIXTURE_ID,
        BUNDLED_METRICS_FIXTURE_ACTION_ID,
      ),
      targetActionId: 'github.metrics',
      executable: true,
      execution: { status: 'success' },
    });
    expect(buildPlanStep).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(policy.planRequests).toHaveLength(1);

    const unsafeRegistry: ActionRegistryPort = {
      list: () => context.operator.actionRegistry.list(),
      get: (actionId) => {
        const action = context.operator.actionRegistry.get(actionId);
        return action ? { ...action, sideEffects: true } : undefined;
      },
      createStep: (...args) => context.operator.actionRegistry.createStep(...args),
      revalidateStep: (...args) => context.operator.actionRegistry.revalidateStep(...args),
      buildPlanSteps: (...args) => context.operator.actionRegistry.buildPlanSteps(...args),
    };
    const unsafeExecute = vi.fn(async () => successfulExecution());
    await expect(
      createPluginActionRunner({
        host: context.pluginHost,
        actionRegistry: unsafeRegistry,
        resolveActivationEvidence: () => fixture.evidence,
        execute: unsafeExecute,
      }).run(BUNDLED_METRICS_FIXTURE_ID, BUNDLED_METRICS_FIXTURE_ACTION_ID),
    ).rejects.toMatchObject({ code: 'PLUGIN_ACTION_BRIDGE_INVALID' });
    expect(unsafeExecute).not.toHaveBeenCalled();

    const isolated = createOpenSlackCliContext({
      workspaceRoot: '.',
      openslackVersion: '0.1.1',
      conversationStoreAdapter: conversationAdapter(),
    });
    expect(isolated.pluginHost.snapshot().actionIds).toEqual([]);
  });

  it('fails closed before host execution when activation evidence is unavailable', async () => {
    const fixture = createBundledMetricsFixture();
    const execute = vi.fn(async () => successfulExecution());
    const context = createOpenSlackCliContext({
      workspaceRoot: '.',
      openslackVersion: '0.1.1',
      pluginPolicy: new FixturePolicy(),
      conversationStoreAdapter: conversationAdapter(),
      bundledPlugins: [fixture.registration],
    });
    const runner = createPluginActionRunner({
      host: context.pluginHost,
      actionRegistry: context.operator.actionRegistry,
      execute,
    });

    await expect(
      runner.run(BUNDLED_METRICS_FIXTURE_ID, BUNDLED_METRICS_FIXTURE_ACTION_ID),
    ).rejects.toMatchObject({
      code: new PluginActionRoutingError('PLUGIN_ACTION_ACTIVATION_EVIDENCE_UNAVAILABLE').code,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the default unconfigured policy and required audit failure closed', async () => {
    const fixture = createBundledMetricsFixture();
    const context = createOpenSlackCliContext({
      workspaceRoot: '.',
      openslackVersion: '0.1.1',
      conversationStoreAdapter: conversationAdapter(),
      bundledPlugins: [fixture.registration],
      resolvePluginActivationEvidence: () => fixture.evidence,
    });

    await expect(
      context.pluginActions.run(BUNDLED_METRICS_FIXTURE_ID, BUNDLED_METRICS_FIXTURE_ACTION_ID),
    ).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_AUDIT_WRITE_FAILED' }],
    });
  });

  it('never reaches the executor when action or plan policy denies', async () => {
    const fixture = createBundledMetricsFixture();
    const policy = new FixturePolicy();
    const execute = vi.fn(async () => successfulExecution());
    const context = createOpenSlackCliContext({
      workspaceRoot: '.',
      openslackVersion: '0.1.1',
      pluginPolicy: policy,
      conversationStoreAdapter: conversationAdapter(),
      bundledPlugins: [fixture.registration],
      resolvePluginActivationEvidence: () => fixture.evidence,
    });
    const runner = createPluginActionRunner({
      host: context.pluginHost,
      actionRegistry: context.operator.actionRegistry,
      resolveActivationEvidence: () => fixture.evidence,
      execute,
    });

    policy.denyAction = true;
    await expect(
      runner.run(BUNDLED_METRICS_FIXTURE_ID, BUNDLED_METRICS_FIXTURE_ACTION_ID),
    ).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_HOST_ACTION_DENIED' }],
    });
    policy.denyAction = false;
    policy.denyPlan = true;
    await expect(
      runner.run(BUNDLED_METRICS_FIXTURE_ID, BUNDLED_METRICS_FIXTURE_ACTION_ID),
    ).rejects.toMatchObject({
      findings: [{ code: 'PLUGIN_HOST_ACTION_DENIED' }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unknown plugin and contribution identities without invoking an executor', async () => {
    const activate = vi.fn();
    const fixture = createBundledMetricsFixture(undefined, activate);
    const execute = vi.fn(async () => successfulExecution());
    const policy = new FixturePolicy();
    const context = createOpenSlackCliContext({
      workspaceRoot: '.',
      openslackVersion: '0.1.1',
      pluginPolicy: policy,
      conversationStoreAdapter: conversationAdapter(),
      bundledPlugins: [fixture.registration],
      resolvePluginActivationEvidence: () => fixture.evidence,
    });
    const runner = createPluginActionRunner({
      host: context.pluginHost,
      actionRegistry: context.operator.actionRegistry,
      resolveActivationEvidence: () => fixture.evidence,
      execute,
    });

    await expect(runner.run('not-registered', 'ready-count')).rejects.toMatchObject({
      code: 'PLUGIN_ACTION_PLUGIN_NOT_REGISTERED',
    });
    await expect(runner.run(BUNDLED_METRICS_FIXTURE_ID, 'not-registered')).rejects.toMatchObject({
      code: 'PLUGIN_ACTION_ACTION_NOT_REGISTERED',
    });
    expect(context.pluginHost.snapshot().plugins[0]?.lifecycle.state).toBe('registered');
    expect(activate).not.toHaveBeenCalled();
    expect(policy.activationRequests).toEqual([]);
    expect(policy.audits).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
