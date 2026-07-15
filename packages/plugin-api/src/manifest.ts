import type { DeclarativePluginCapability } from './capabilities.js';
import type { DeclarativeContributionV1 } from './contributions.js';

export const PLUGIN_MANIFEST_SCHEMA = 'openslack.plugin.v1' as const;
export const PLUGIN_GATE_MODES = Object.freeze(['SHADOW', 'ENFORCE'] as const);
export type PluginGateMode = (typeof PLUGIN_GATE_MODES)[number];

export const PLUGIN_ID_PATTERN_SOURCE = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
export const HOST_REFERENCE_PATTERN_SOURCE = '[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*';
export const MANIFEST_SEMVER_PATTERN_SOURCE =
  '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const OPENSLACK_RANGE_VERSION_PATTERN_SOURCE =
  '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)';
export const OPENSLACK_VERSION_RANGE_PATTERN_SOURCE = `(?:\\^|~|>=|<=|>|<|=)?${OPENSLACK_RANGE_VERSION_PATTERN_SOURCE}(?:[ ]+(?:\\^|~|>=|<=|>|<|=)?${OPENSLACK_RANGE_VERSION_PATTERN_SOURCE})*`;

export const RESERVED_PLUGIN_IDS = Object.freeze([
  'openslack',
  'built-in',
  'plugin',
  'workspace',
  'external',
  'negentropy',
] as const);

export const FORBIDDEN_MAPPING_FIELD_NAMES = Object.freeze([
  '__proto__',
  'prototype',
  'constructor',
  'toString',
  'command',
  'argv',
  'args',
  'shell',
  'exec',
  'spawn',
  'template',
  'path',
  'file',
  'module',
  'url',
  'risk',
  'riskLevel',
  'riskZone',
  'confirmationRequired',
] as const);

export interface PluginGateRequest {
  readonly mode: PluginGateMode;
  readonly gateId: string;
}

export interface PluginManifestV1 {
  readonly schema: typeof PLUGIN_MANIFEST_SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly requires: {
    readonly openslack: string;
  };
  readonly gate: PluginGateRequest;
  readonly capabilities: readonly DeclarativePluginCapability[];
  readonly contributes: readonly DeclarativeContributionV1[];
}
