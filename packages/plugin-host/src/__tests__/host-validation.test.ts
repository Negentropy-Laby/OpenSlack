import { describe, expect, it } from 'vitest';
import {
  HostInputValidationError,
  assertCompatibleOpenSlackVersion,
  normalizeActivationDecision,
  normalizeActivationEvidence,
} from '../host-validation.js';

const HASH = 'a'.repeat(64);

function evidence() {
  return {
    schema: 'openslack.plugin_activation_evidence.v1',
    plugin: { id: 'observer', version: '1.0.0' },
    observedAt: '2026-07-16T00:00:00.000Z',
    actor: { id: 'human-reviewer', kind: 'human', provider: 'github' },
    humanApproval: { required: true, satisfied: true, evidenceRefs: ['review:197'] },
    providerKind: 'workspace',
    source: {
      kind: 'locked_manifest',
      sourceRef: '.openslack/plugins/observer/plugin.json',
      manifestSha256: HASH,
      lockManifestSha256: HASH,
      integrityMatched: true,
    },
  };
}

describe('host input validation', () => {
  it('rebuilds evidence only after matching every host-owned integrity field', () => {
    expect(
      normalizeActivationEvidence(evidence(), {
        id: 'observer',
        version: '1.0.0',
        providerKind: 'workspace',
        sourceRef: '.openslack/plugins/observer/plugin.json',
        manifestSha256: HASH,
        lockManifestSha256: HASH,
      }),
    ).toMatchObject({ providerKind: 'workspace', source: { integrityMatched: true } });
  });

  it('does not trust integrityMatched or approval booleans by themselves', () => {
    const forged = evidence();
    forged.source.manifestSha256 = 'b'.repeat(64);
    expect(() =>
      normalizeActivationEvidence(forged, {
        id: 'observer',
        version: '1.0.0',
        providerKind: 'workspace',
        sourceRef: '.openslack/plugins/observer/plugin.json',
        manifestSha256: HASH,
        lockManifestSha256: HASH,
      }),
    ).toThrowError(HostInputValidationError);
  });

  it('rejects accessor, symbol, and capability-escalating policy data', () => {
    const value = evidence() as Record<PropertyKey, unknown>;
    Object.defineProperty(value, 'observedAt', { enumerable: true, get: () => '2026-01-01' });
    expect(() =>
      normalizeActivationEvidence(value, {
        id: 'observer',
        version: '1.0.0',
        providerKind: 'workspace',
        sourceRef: 'x',
        manifestSha256: HASH,
        lockManifestSha256: HASH,
      }),
    ).toThrowError(HostInputValidationError);

    expect(() =>
      normalizeActivationDecision({
        outcome: 'allow',
        code: 'PLUGIN_ACTIVATION_ALLOWED',
        reason: 'ok',
        hostAllowedCapabilities: ['root.anything'],
        actorAllowedCapabilities: [],
        evidenceRefs: [],
      }),
    ).toThrowError(HostInputValidationError);
  });

  it('implements bounded conjunction, caret, and tilde ranges', () => {
    expect(() => assertCompatibleOpenSlackVersion('0.1.1', '>=0.1.0 <0.2.0')).not.toThrow();
    expect(() => assertCompatibleOpenSlackVersion('0.1.1', '^0.1.0')).not.toThrow();
    expect(() => assertCompatibleOpenSlackVersion('0.1.1', '~0.1.0')).not.toThrow();
    expect(() => assertCompatibleOpenSlackVersion('0.2.0', '^0.1.0')).toThrowError(
      HostInputValidationError,
    );
  });
});
