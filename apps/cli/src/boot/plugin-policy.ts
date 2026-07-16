import type { HostPlanStep, HostPolicyPort, PluginAuditEvent } from '@openslack/plugin-api';

const POLICY_NOT_COMPOSED = 'Plugin execution policy is not composed in this CLI boot path.';

/**
 * P2-PR2 only composes the host boundary. Until an application supplies its
 * kernel/PRMS policy and durable audit sink, every plugin operation fails closed.
 */
export function createUnconfiguredPluginPolicy(): HostPolicyPort<HostPlanStep> {
  return Object.freeze({
    authorizeActivation() {
      return {
        outcome: 'deny' as const,
        code: 'PLUGIN_POLICY_NOT_COMPOSED',
        reason: POLICY_NOT_COMPOSED,
        evidenceRefs: [],
      };
    },
    authorizeAction() {
      return {
        outcome: 'deny' as const,
        code: 'PLUGIN_POLICY_NOT_COMPOSED',
        reason: POLICY_NOT_COMPOSED,
        evidenceRefs: [],
      };
    },
    validatePlanStep() {
      return {
        outcome: 'deny' as const,
        code: 'PLUGIN_POLICY_NOT_COMPOSED',
        reason: POLICY_NOT_COMPOSED,
        evidenceRefs: [],
      };
    },
    recordAuditEvent(_event: PluginAuditEvent): never {
      throw new Error(`${POLICY_NOT_COMPOSED} Durable plugin audit is unavailable.`);
    },
  });
}
