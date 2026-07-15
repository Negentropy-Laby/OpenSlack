import { describe, expect, it } from 'vitest';
import type { ManifestValidationFinding } from '@openslack/plugin-api';
import { validateManifestForHost } from '../manifest-policy.js';

function manifest() {
  const inputMapping: Record<string, unknown> = {
    verbose: { kind: 'input', name: 'verbose' },
  };
  return {
    schema: 'openslack.plugin.v1',
    id: 'safe-observer',
    version: '1.0.0',
    name: 'Safe observer',
    requires: { openslack: '>=0.1.0 <1.0.0' },
    gate: { mode: 'SHADOW', gateId: 'host.read-only' },
    capabilities: ['host.actions.read'],
    contributes: [
      {
        kind: 'action_alias',
        id: 'status',
        inputs: { verbose: { type: 'boolean' } },
        inputMapping,
        target: { kind: 'host_action', id: 'status.show' },
      },
    ],
  };
}

describe('Red host manifest policy', () => {
  it('accepts a closed read-only manifest without importing the authoring validator', () => {
    expect(validateManifestForHost(manifest())).toMatchObject({ valid: true });
  });

  it.each(['entry', 'Command', 'URL', 'RiskZone', 'providerKind', 'humanApproval'])(
    'rejects independently forbidden field %s',
    (field) => {
      const value = manifest() as Record<string, unknown>;
      value[field] = 'unsafe';
      const result = validateManifestForHost(value);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.findings.some((finding: ManifestValidationFinding) =>
            /FORBIDDEN/.test(finding.code),
          ),
        ).toBe(true);
      }
    },
  );

  it('rejects reserved IDs, merge aliases, unsafe display text, and undeclared mappings', () => {
    const value = manifest();
    value.id = 'openslack-host';
    value.name = '\u001b[31mspoof';
    value.contributes[0]!.target.id = 'pr.merge';
    value.contributes[0]!.inputMapping = { value: { kind: 'input', name: 'missing' } };
    const result = validateManifestForHost(value);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.findings.map((finding: ManifestValidationFinding) => finding.code)).toEqual(
        expect.arrayContaining([
          'PLUGIN_MANIFEST_ID_RESERVED',
          'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
          'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
        ]),
      );
    }
  });
});
