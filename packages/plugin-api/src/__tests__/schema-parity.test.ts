import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  DECLARATIVE_CONTRIBUTION_KINDS,
  DECLARATIVE_PLUGIN_CAPABILITIES,
  FORBIDDEN_MAPPING_FIELD_NAMES,
  INPUT_DEFINITION_TYPES,
  MANIFEST_SEMVER_PATTERN_SOURCE,
  OPENSLACK_VERSION_RANGE_PATTERN_SOURCE,
  PLUGIN_GATE_MODES,
  PLUGIN_MANIFEST_V1_JSON_SCHEMA,
  validatePluginManifest,
} from '../index.js';
import { loadManifestFixtureCases } from './fixture-cases.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(PLUGIN_MANIFEST_V1_JSON_SCHEMA);
const fixtures = loadManifestFixtureCases();

describe('plugin manifest schema parity', () => {
  it.each(fixtures)('$name has identical runtime and JSON Schema validity', ({ value, valid }) => {
    const runtimeValid = validatePluginManifest(value).valid;
    const schemaValid = validateSchema(value) as boolean;
    expect(runtimeValid).toBe(valid);
    expect(schemaValid, JSON.stringify(validateSchema.errors)).toBe(valid);
    expect(runtimeValid).toBe(schemaValid);
  });

  it('keeps closed enums aligned with TypeScript constants', () => {
    const schema = PLUGIN_MANIFEST_V1_JSON_SCHEMA as {
      properties: {
        capabilities: { items: { enum: string[] } };
        gate: { properties: { mode: { enum: string[] } } };
        requires: { properties: { openslack: { pattern: string } } };
        version: { pattern: string };
      };
      $defs: {
        inputDefinition: { properties: { type: { enum: string[] } } };
        inputDefinitions: {
          propertyNames: { allOf: [unknown, { not: { enum: string[] } }] };
        };
        inputBinding: { properties: { name: { not: { enum: string[] } } } };
        actionAlias: { properties: { kind: { const: string } } };
        workflowAlias: { properties: { kind: { const: string } } };
      };
    };
    expect(schema.properties.capabilities.items.enum).toEqual(DECLARATIVE_PLUGIN_CAPABILITIES);
    expect(schema.properties.gate.properties.mode.enum).toEqual(PLUGIN_GATE_MODES);
    expect(schema.properties.version.pattern).toBe(`^${MANIFEST_SEMVER_PATTERN_SOURCE}$`);
    expect(schema.properties.requires.properties.openslack.pattern).toBe(
      `^${OPENSLACK_VERSION_RANGE_PATTERN_SOURCE}$`,
    );
    expect(schema.$defs.inputDefinition.properties.type.enum).toEqual(INPUT_DEFINITION_TYPES);
    expect(schema.$defs.inputDefinitions.propertyNames.allOf[1].not.enum).toEqual(
      FORBIDDEN_MAPPING_FIELD_NAMES,
    );
    expect(schema.$defs.inputBinding.properties.name.not.enum).toEqual(
      FORBIDDEN_MAPPING_FIELD_NAMES,
    );
    expect([
      schema.$defs.actionAlias.properties.kind.const,
      schema.$defs.workflowAlias.properties.kind.const,
    ]).toEqual(DECLARATIVE_CONTRIBUTION_KINDS);
  });

  it('does not expose host-derived trust or lifecycle fields', () => {
    const properties = (PLUGIN_MANIFEST_V1_JSON_SCHEMA as { properties: Record<string, unknown> })
      .properties;
    for (const field of ['providerKind', 'source', 'lifecycle', 'state', 'activationEvidence']) {
      expect(properties).not.toHaveProperty(field);
    }
  });
});
