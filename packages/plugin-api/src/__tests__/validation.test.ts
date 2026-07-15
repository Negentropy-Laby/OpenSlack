import { describe, expect, it } from 'vitest';
import {
  PluginManifestValidationError,
  assertPluginManifestV1,
  isPluginManifestV1,
  validatePluginManifest,
} from '../validation.js';
import { loadManifestFixtureCases } from './fixture-cases.js';

const fixtures = loadManifestFixtureCases();
const EXPECTED_SECURITY_CODES = {
  'invalid/executable-entry.json': 'PLUGIN_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN',
  'invalid/provider-kind.json': 'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
  'invalid/negentropy-authority.json': 'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
  'invalid/lifecycle-spoof.json': 'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
} as const;

describe('validatePluginManifest', () => {
  it.each(fixtures)('$name matches expected validity', ({ name, value, valid }) => {
    const result = validatePluginManifest(value);
    expect(result.valid).toBe(valid);
    expect(isPluginManifestV1(value)).toBe(valid);
    if (valid) {
      expect(result.valid && result.manifest).toBe(value);
      expect(result.findings).toEqual([]);
    } else {
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings.every((finding) => finding.severity === 'error')).toBe(true);
      const expectedCode = EXPECTED_SECURITY_CODES[name as keyof typeof EXPECTED_SECURITY_CODES];
      if (expectedCode) {
        expect(result.findings.some((finding) => finding.code === expectedCode)).toBe(true);
      }
    }
  });

  it.each([
    null,
    [],
    new Date(),
    Object.create({ schema: 'openslack.plugin.v1' }),
    () => undefined,
  ])('rejects non-plain manifest value %#', (value) => {
    const result = validatePluginManifest(value);
    expect(result.valid).toBe(false);
    expect(result.findings[0]?.code).toBe('PLUGIN_MANIFEST_NOT_OBJECT');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite constant %s',
    (value) => {
      const manifest = structuredClone(
        fixtures.find((fixture) => fixture.name === 'valid/mixed-aliases.json')!.value,
      ) as {
        contributes: Array<{ inputMapping?: Record<string, { value: unknown }> }>;
      };
      manifest.contributes[0]!.inputMapping!.prNumber!.value = value;
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.findings.some((finding) => finding.path.endsWith('/value'))).toBe(true);
    },
  );

  it('returns findings in deterministic JSON-pointer order', () => {
    const result = validatePluginManifest({ unknown: true });
    expect(result.valid).toBe(false);
    const sorted = [...result.findings].sort(
      (a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code),
    );
    expect(result.findings).toEqual(sorted);
  });

  it('asserts valid values and throws a typed error for invalid values', () => {
    const valid = fixtures.find((fixture) => fixture.valid)!.value;
    expect(() => assertPluginManifestV1(valid)).not.toThrow();
    expect(() => assertPluginManifestV1({})).toThrow(PluginManifestValidationError);
  });
});
