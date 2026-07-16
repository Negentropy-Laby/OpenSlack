import {
  BUILTIN_ACTION_REGISTRY,
  createActionRegistry,
  type RegisteredAction,
} from '@openslack/operator';
import type { HostPolicyPort } from '@openslack/plugin-api';
import { PluginHost } from '@openslack/plugin-host';
import { describe, expect, it, vi } from 'vitest';
import { createOperatorActionTargetCatalog } from '../operator-action-adapter.js';

function action(id: string): RegisteredAction {
  const registered = BUILTIN_ACTION_REGISTRY.get(id);
  if (!registered) throw new Error(`Missing test action: ${id}`);
  return registered;
}

const denyOnlyPolicy = Object.freeze({
  authorizeActivation: () => ({
    outcome: 'deny',
    code: 'TEST_DENY',
    reason: 'No activation is needed by this adapter test.',
    evidenceRefs: [],
  }),
  authorizeAction: () => ({
    outcome: 'deny',
    code: 'TEST_DENY',
    reason: 'No action is executed by this adapter test.',
    evidenceRefs: [],
  }),
  validatePlanStep: () => ({
    outcome: 'deny',
    code: 'TEST_DENY',
    reason: 'No plan step is executed by this adapter test.',
    evidenceRefs: [],
  }),
  recordAuditEvent: () => undefined,
} satisfies HostPolicyPort);

describe('Operator action target adapter', () => {
  it('projects only the built-in target with a complete capability and output contract', () => {
    const catalog = createOperatorActionTargetCatalog(BUILTIN_ACTION_REGISTRY);
    const actions = catalog.actions ?? [];
    const byId = new Map(actions.map((target) => [target.id, target]));

    expect(byId.has('status.show')).toBe(false);
    expect(byId.get('github.metrics')).toEqual({
      kind: 'host_action',
      id: 'github.metrics',
      exists: true,
      declarativeAliasAllowed: true,
      sideEffects: false,
      risk: 'none',
      confirmationRequired: false,
      exposesSecrets: false,
      exposesCredentials: false,
      exposesPaths: false,
      requiredCapability: 'github.issues.read',
      inputSchema: {},
    });
    expect(byId.has('pr.merge')).toBe(false);
    expect(byId.has('task.sync')).toBe(false);
    expect(byId.has('task.create.preview')).toBe(false);
    expect(byId.has('pr.status')).toBe(false);
    expect(byId.has('pr.review')).toBe(false);
    expect(byId.has('conversation.list')).toBe(false);
    expect(byId.has('self.eval.golden')).toBe(false);
    expect(actions.map((target) => target.id)).toEqual(['github.metrics']);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(actions)).toBe(true);
    expect(actions.every((target) => Object.isFrozen(target))).toBe(true);

    expect(
      () =>
        new PluginHost({
          policy: denyOnlyPolicy,
          binding: {
            compositionId: 'openslack.cli.adapter-test',
            openslackVersion: '0.1.1',
            gateIds: [],
            targets: catalog,
          },
        }),
    ).not.toThrow();
  });

  it('omits read-only actions whose complete capability and disclosure behavior is unproven', () => {
    const registry = createActionRegistry([
      action('status.show'),
      action('github.metrics'),
      action('pr.status'),
      action('conversation.list'),
    ]);

    expect(createOperatorActionTargetCatalog(registry).actions?.map((target) => target.id)).toEqual(
      ['github.metrics'],
    );
  });

  it('does not leak action targets between registry instances', () => {
    const metricsRegistry = createActionRegistry([action('github.metrics')]);
    const doctorRegistry = createActionRegistry([action('doctor.run')]);

    expect(
      createOperatorActionTargetCatalog(metricsRegistry).actions?.map((target) => target.id),
    ).toEqual(['github.metrics']);
    expect(
      createOperatorActionTargetCatalog(doctorRegistry).actions?.map((target) => target.id),
    ).toEqual([]);
    expect(
      createOperatorActionTargetCatalog(metricsRegistry).actions?.map((target) => target.id),
    ).toEqual(['github.metrics']);
  });

  it('reads metadata only and never invokes action behavior', () => {
    const build = vi.fn();
    const match = vi.fn();
    const registry = createActionRegistry([
      {
        id: 'plugin:fixture:read-only',
        description: 'Read-only fixture',
        inputSchema: {},
        riskLevel: 'none',
        sideEffects: false,
        confirmationRequired: false,
        build,
        match,
      },
    ]);

    expect(createOperatorActionTargetCatalog(registry).actions).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
  });
});
