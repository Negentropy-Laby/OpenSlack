import { describe, expect, it } from 'vitest';
import {
  PluginHostError,
  asciiCompare,
  failPluginHost,
  sortFindings,
  type PluginHostFinding,
} from '../findings.js';

describe('plugin host findings', () => {
  it('orders strings by deterministic code units without locale collation', () => {
    const values = ['z', 'ä', 'A', 'a', '10', '2'];
    expect([...values].sort(asciiCompare)).toEqual(['10', '2', 'A', 'a', 'z', 'ä']);
  });

  it('sorts and freezes findings deterministically', () => {
    const findings: PluginHostFinding[] = [
      {
        phase: 'registration',
        code: 'PLUGIN_REGISTRY_PLUGIN_COLLISION',
        pluginId: 'zeta',
        summary: 'collision',
      },
      {
        phase: 'registration',
        code: 'PLUGIN_REGISTRY_PLUGIN_COLLISION',
        pluginId: 'alpha',
        summary: 'collision',
      },
      {
        phase: 'audit',
        code: 'PLUGIN_AUDIT_WRITE_FAILED',
        summary: 'audit failed',
      },
    ];

    const sorted = sortFindings(findings);
    expect(sorted.map((finding) => `${finding.phase}:${finding.pluginId ?? ''}`)).toEqual([
      'audit:',
      'registration:alpha',
      'registration:zeta',
    ]);
    expect(Object.isFrozen(sorted)).toBe(true);
    expect(findings[0]?.pluginId).toBe('zeta');
  });

  it('throws one stable typed error without exposing an arbitrary cause', () => {
    expect(() =>
      failPluginHost({
        phase: 'binding',
        code: 'PLUGIN_HOST_NOT_BOUND',
        summary: 'The host has not been bound.',
      }),
    ).toThrow(PluginHostError);

    try {
      failPluginHost({
        phase: 'binding',
        code: 'PLUGIN_HOST_NOT_BOUND',
        summary: 'The host has not been bound.',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PluginHostError);
      expect((error as PluginHostError).findings[0]?.code).toBe('PLUGIN_HOST_NOT_BOUND');
      expect((error as Error).message).toBe('PLUGIN_HOST_NOT_BOUND: The host has not been bound.');
    }
  });
});
