import { describe, expect, it } from 'vitest';
import { normalizeTypedEvidenceReference, normalizeTypedEvidenceReferences } from '../sanitizer.js';

describe('typed MCP evidence references', () => {
  it('accepts a bounded versioned repository assumption reference', () => {
    expect(normalizeTypedEvidenceReference('repo:path/to/assumptions.yaml#annualValue@v1')).toBe(
      'repo:path/to/assumptions.yaml#annualValue@v1',
    );
    expect(
      normalizeTypedEvidenceReference(
        'repo:.openslack/assumptions.yaml#estimatedManualHours@2026-07-26',
      ),
    ).toBe('repo:.openslack/assumptions.yaml#estimatedManualHours@2026-07-26');
    const maximumPath = `repo:${'a'.repeat(374)}#annualValue@v1`;
    expect(normalizeTypedEvidenceReference(maximumPath)).toBe(maximumPath);
  });

  it.each([
    'repo:../secrets.yaml#annualValue@v1',
    'repo:path/../secrets.yaml#annualValue@v1',
    'repo:/absolute/assumptions.yaml#annualValue@v1',
    'repo:C:\\private\\assumptions.yaml#annualValue@v1',
    'repo:path/assumptions.yaml#annualValue',
    'repo:path/assumptions.yaml#annualValue@v1?token=value',
    `repo:${'a'.repeat(375)}#annualValue@v1`,
    `event:${'a'.repeat(508)}`,
  ])('rejects unsafe or over-bound repository evidence: %s', (reference) => {
    expect(normalizeTypedEvidenceReference(reference)).toBeUndefined();
  });

  it('rejects a proxied evidence array without executing traps', () => {
    let traps = 0;
    const values = new Proxy([] as unknown[], {
      get() {
        traps += 1;
        throw new Error('get trap executed');
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error('prototype trap executed');
      },
      ownKeys() {
        traps += 1;
        throw new Error('ownKeys trap executed');
      },
    });
    expect(() => normalizeTypedEvidenceReferences(values)).toThrow(
      /PROTOCOL_OUTPUT_PROXY_REJECTED/,
    );
    expect(traps).toBe(0);
  });
});
