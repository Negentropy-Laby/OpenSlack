import { describe, expect, it } from 'vitest';

import { createUnconfiguredPluginPolicy } from '../plugin-policy.js';

describe('unconfigured CLI plugin policy', () => {
  it('denies authority and fails closed when durable audit is unavailable', async () => {
    const policy = createUnconfiguredPluginPolicy();
    const evidence = {
      schema: 'openslack.plugin_activation_evidence.v1' as const,
      plugin: { id: 'fixture', version: '1.0.0' },
      observedAt: '2026-07-16T00:00:00.000Z',
      actor: { id: 'cli', kind: 'system' as const, provider: 'openslack' },
      humanApproval: { required: false, satisfied: false, evidenceRefs: [] },
      providerKind: 'built-in' as const,
      source: { kind: 'built_in' as const, compositionId: 'openslack.cli' },
    };

    expect(await policy.authorizeActivation({ requestedCapabilities: [], evidence })).toMatchObject(
      { outcome: 'deny', code: 'PLUGIN_POLICY_NOT_COMPOSED' },
    );
    expect(() =>
      policy.recordAuditEvent({
        schema: 'openslack.plugin_audit_event.v1',
        type: 'plugin.activation.requested',
        plugin: evidence.plugin,
        providerKind: 'built-in',
        occurredAt: evidence.observedAt,
        summary: 'requested',
        evidenceRefs: [],
      }),
    ).toThrow('Durable plugin audit is unavailable');
  });
});
