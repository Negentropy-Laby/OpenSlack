import { describe, expect, it } from 'vitest';
import { normalizeTypedEvidenceReference } from '../sanitizer.js';

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
});
