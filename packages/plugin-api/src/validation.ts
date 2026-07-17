import schemaJson from './plugin-manifest.schema.json' with { type: 'json' };
import {
  DECLARATIVE_PLUGIN_CAPABILITIES,
  isDeclarativePluginCapability,
  type DeclarativePluginCapability,
} from './capabilities.js';
import {
  DECLARATIVE_CONTRIBUTION_KINDS,
  INPUT_DEFINITION_TYPES,
  type DeclarativeContributionV1,
  type DeclarativeInputBindingV1,
  type PluginInputDefinitionV1,
} from './contributions.js';
import {
  FORBIDDEN_MAPPING_FIELD_NAMES,
  HOST_REFERENCE_PATTERN_SOURCE,
  MANIFEST_SEMVER_PATTERN_SOURCE,
  OPENSLACK_VERSION_RANGE_PATTERN_SOURCE,
  PLUGIN_GATE_MODES,
  PLUGIN_ID_PATTERN_SOURCE,
  PLUGIN_MANIFEST_SCHEMA,
  RESERVED_PLUGIN_IDS,
  type PluginManifestV1,
} from './manifest.js';
import {
  isPluginManifestAuthorityFieldName,
  isPluginManifestExecutableFieldName,
} from './manifest-security.js';

export const PLUGIN_MANIFEST_V1_JSON_SCHEMA = schemaJson as Readonly<Record<string, unknown>>;

export const MANIFEST_VALIDATION_CODES = [
  'PLUGIN_MANIFEST_NOT_OBJECT',
  'PLUGIN_MANIFEST_SCHEMA_UNSUPPORTED',
  'PLUGIN_MANIFEST_FIELD_REQUIRED',
  'PLUGIN_MANIFEST_FIELD_UNKNOWN',
  'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
  'PLUGIN_MANIFEST_ID_INVALID',
  'PLUGIN_MANIFEST_ID_RESERVED',
  'PLUGIN_MANIFEST_VERSION_INVALID',
  'PLUGIN_MANIFEST_VERSION_RANGE_INVALID',
  'PLUGIN_MANIFEST_CAPABILITY_INVALID',
  'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
  'PLUGIN_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN',
  'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
  'PLUGIN_MANIFEST_REFERENCE_INVALID',
] as const;

export type ManifestValidationCode = (typeof MANIFEST_VALIDATION_CODES)[number];

export interface ManifestValidationFinding {
  readonly severity: 'error';
  readonly code: ManifestValidationCode;
  readonly path: string;
  readonly message: string;
}

export type PluginManifestValidationResult =
  | {
      readonly valid: true;
      readonly manifest: PluginManifestV1;
      readonly findings: readonly [];
    }
  | {
      readonly valid: false;
      readonly findings: readonly ManifestValidationFinding[];
    };

const ROOT_FIELDS = [
  'schema',
  'id',
  'version',
  'name',
  'description',
  'requires',
  'gate',
  'capabilities',
  'contributes',
] as const;
const REQUIRED_ROOT_FIELDS = [
  'schema',
  'id',
  'version',
  'name',
  'requires',
  'gate',
  'capabilities',
  'contributes',
] as const;
const CONTRIBUTION_FIELDS = [
  'kind',
  'id',
  'title',
  'description',
  'inputs',
  'inputMapping',
  'target',
] as const;
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const PLUGIN_ID_PATTERN = new RegExp(`^${PLUGIN_ID_PATTERN_SOURCE}$`);
const HOST_REFERENCE_PATTERN = new RegExp(`^${HOST_REFERENCE_PATTERN_SOURCE}$`);
const MANIFEST_SEMVER_PATTERN = new RegExp(`^${MANIFEST_SEMVER_PATTERN_SOURCE}$`);
const OPENSLACK_VERSION_RANGE_PATTERN = new RegExp(`^${OPENSLACK_VERSION_RANGE_PATTERN_SOURCE}$`);
const FORBIDDEN_FIELDS = new Set<string>(FORBIDDEN_MAPPING_FIELD_NAMES);
const RESERVED_IDS = new Set<string>(RESERVED_PLUGIN_IDS);
const CONTRIBUTION_KINDS = new Set<unknown>(DECLARATIVE_CONTRIBUTION_KINDS);
const INPUT_TYPES = new Set<unknown>(INPUT_DEFINITION_TYPES);
const GATE_MODES = new Set<unknown>(PLUGIN_GATE_MODES);
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function pointer(parent: string, segment: string | number): string {
  const escaped = String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
  return `${parent}/${escaped}`;
}

interface JsonValueIssue {
  readonly path: string;
  readonly message: string;
}

function inspectJsonValue(
  value: unknown,
  path: string,
  activeObjects: WeakSet<object>,
): JsonValueIssue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : { path, message: 'JSON numbers must be finite.' };
  }
  if (typeof value !== 'object') {
    return { path, message: `Value of type ${typeof value} is not valid JSON.` };
  }
  if (activeObjects.has(value)) {
    return { path, message: 'Cyclic values are not valid JSON.' };
  }
  activeObjects.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      const allowedKeys = new Set<string>(['length']);
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          return {
            path: pointer(path, index),
            message: 'JSON arrays must be dense and contain enumerable data properties.',
          };
        }
        const issue = inspectJsonValue(descriptor.value, pointer(path, index), activeObjects);
        if (issue) return issue;
      }
      for (const key of keys) {
        if (typeof key === 'symbol') {
          return { path, message: 'Symbol-keyed properties are not valid JSON.' };
        }
        if (!allowedKeys.has(key)) {
          return {
            path: pointer(path, key),
            message: 'JSON arrays cannot contain named properties.',
          };
        }
      }
      return undefined;
    }
    if (!isRecord(value)) {
      return { path, message: 'Expected a plain JSON object.' };
    }
    for (const key of keys) {
      if (typeof key === 'symbol') {
        return { path, message: 'Symbol-keyed properties are not valid JSON.' };
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return {
          path: pointer(path, key),
          message: 'JSON objects must contain enumerable data properties, not accessors.',
        };
      }
      const issue = inspectJsonValue(descriptor.value, pointer(path, key), activeObjects);
      if (issue) return issue;
    }
    return undefined;
  } catch {
    return { path, message: 'Value could not be inspected as plain JSON.' };
  } finally {
    activeObjects.delete(value);
  }
}

function addFinding(
  findings: ManifestValidationFinding[],
  code: ManifestValidationCode,
  path: string,
  message: string,
): void {
  findings.push({ severity: 'error', code, path, message });
}

function checkExactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  findings: ManifestValidationFinding[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      const code: ManifestValidationCode = isPluginManifestExecutableFieldName(key)
        ? 'PLUGIN_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN'
        : isPluginManifestAuthorityFieldName(key)
          ? 'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN'
          : 'PLUGIN_MANIFEST_FIELD_UNKNOWN';
      addFinding(findings, code, pointer(path, key), `Unknown field "${key}" is not allowed.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      addFinding(
        findings,
        'PLUGIN_MANIFEST_FIELD_REQUIRED',
        pointer(path, key),
        `Required field "${key}" is missing.`,
      );
    }
  }
}

function checkString(
  value: unknown,
  path: string,
  findings: ManifestValidationFinding[],
  options: { min?: number; max: number; pattern?: RegExp; code?: ManifestValidationCode },
): value is string {
  if (typeof value !== 'string') {
    addFinding(findings, 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID', path, 'Expected a string.');
    return false;
  }
  const min = options.min ?? 1;
  const codePointLength = Array.from(value).length;
  if (
    codePointLength < min ||
    codePointLength > options.max ||
    (options.pattern && !options.pattern.test(value))
  ) {
    addFinding(
      findings,
      options.code ?? 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      path,
      'String value does not satisfy the manifest contract.',
    );
    return false;
  }
  return true;
}

function isForbiddenFieldName(value: string): boolean {
  return FORBIDDEN_FIELDS.has(value);
}

function checkFieldName(
  value: string,
  path: string,
  findings: ManifestValidationFinding[],
): boolean {
  if (!FIELD_NAME_PATTERN.test(value)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_REFERENCE_INVALID',
      path,
      'Field name is not a valid bounded identifier.',
    );
    return false;
  }
  if (isForbiddenFieldName(value)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
      path,
      `Security-sensitive field "${value}" cannot be mapped by a declarative plugin.`,
    );
    return false;
  }
  return true;
}

function validateInputDefinition(
  value: unknown,
  path: string,
  findings: ManifestValidationFinding[],
): value is PluginInputDefinitionV1 {
  if (!isRecord(value)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      path,
      'Expected an input definition object.',
    );
    return false;
  }
  checkExactFields(value, ['type', 'required', 'description'], ['type'], path, findings);
  if (!INPUT_TYPES.has(value.type)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      pointer(path, 'type'),
      'Input type must be string, number, or boolean.',
    );
  }
  if (Object.hasOwn(value, 'required') && typeof value.required !== 'boolean') {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      pointer(path, 'required'),
      'Input required must be a boolean.',
    );
  }
  if (Object.hasOwn(value, 'description')) {
    checkString(value.description, pointer(path, 'description'), findings, { max: 240 });
  }
  return true;
}

function validateInputDefinitions(
  value: unknown,
  path: string,
  findings: ManifestValidationFinding[],
): boolean {
  if (!isRecord(value)) {
    addFinding(findings, 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID', path, 'Expected an inputs object.');
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length > 32) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      path,
      'Inputs exceed the 32-field limit.',
    );
  }
  for (const key of keys) {
    checkFieldName(key, pointer(path, key), findings);
    validateInputDefinition(value[key], pointer(path, key), findings);
  }
  return true;
}

function validateInputBinding(
  value: unknown,
  path: string,
  findings: ManifestValidationFinding[],
): value is DeclarativeInputBindingV1 {
  if (!isRecord(value)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      path,
      'Expected an input binding object.',
    );
    return false;
  }
  if (value.kind === 'constant') {
    checkExactFields(value, ['kind', 'value'], ['kind', 'value'], path, findings);
    if (
      !['string', 'number', 'boolean'].includes(typeof value.value) ||
      (typeof value.value === 'number' && !Number.isFinite(value.value))
    ) {
      addFinding(
        findings,
        'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
        pointer(path, 'value'),
        'Constant bindings accept only finite string, number, or boolean values.',
      );
    }
    return true;
  }
  if (value.kind === 'input') {
    checkExactFields(value, ['kind', 'name'], ['kind', 'name'], path, findings);
    if (typeof value.name !== 'string') {
      addFinding(
        findings,
        'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
        pointer(path, 'name'),
        'Input binding name must be a string.',
      );
    } else {
      checkFieldName(value.name, pointer(path, 'name'), findings);
    }
    return true;
  }
  checkExactFields(value, ['kind'], ['kind'], path, findings);
  addFinding(
    findings,
    'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
    pointer(path, 'kind'),
    'Input binding kind must be constant or input.',
  );
  return false;
}

function validateInputMapping(
  value: unknown,
  path: string,
  findings: ManifestValidationFinding[],
): boolean {
  if (!isRecord(value)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      path,
      'Expected an inputMapping object.',
    );
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length > 32) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      path,
      'Input mapping exceeds the 32-field limit.',
    );
  }
  for (const key of keys) {
    checkFieldName(key, pointer(path, key), findings);
    validateInputBinding(value[key], pointer(path, key), findings);
  }
  return true;
}

function validateContribution(
  value: unknown,
  path: string,
  findings: ManifestValidationFinding[],
): value is DeclarativeContributionV1 {
  if (!isRecord(value)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
      path,
      'Expected a contribution object.',
    );
    return false;
  }
  checkExactFields(value, CONTRIBUTION_FIELDS, ['kind', 'id', 'target'], path, findings);
  if (!CONTRIBUTION_KINDS.has(value.kind)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
      pointer(path, 'kind'),
      'Contribution kind must be action_alias or workflow_alias.',
    );
    return false;
  }
  checkString(value.id, pointer(path, 'id'), findings, {
    max: 64,
    pattern: PLUGIN_ID_PATTERN,
    code: 'PLUGIN_MANIFEST_ID_INVALID',
  });
  if (Object.hasOwn(value, 'title')) {
    checkString(value.title, pointer(path, 'title'), findings, { max: 120 });
  }
  if (Object.hasOwn(value, 'description')) {
    checkString(value.description, pointer(path, 'description'), findings, { max: 512 });
  }
  if (Object.hasOwn(value, 'inputs')) {
    validateInputDefinitions(value.inputs, pointer(path, 'inputs'), findings);
  }
  if (Object.hasOwn(value, 'inputMapping')) {
    validateInputMapping(value.inputMapping, pointer(path, 'inputMapping'), findings);
  }
  if (!isRecord(value.target)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      pointer(path, 'target'),
      'Contribution target must be an object.',
    );
    return false;
  }
  checkExactFields(value.target, ['kind', 'id'], ['kind', 'id'], pointer(path, 'target'), findings);
  const expectedTargetKind = value.kind === 'action_alias' ? 'host_action' : 'host_workflow';
  if (value.target.kind !== expectedTargetKind) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_REFERENCE_INVALID',
      pointer(pointer(path, 'target'), 'kind'),
      `Expected target kind ${expectedTargetKind}.`,
    );
  }
  if (
    checkString(value.target.id, pointer(pointer(path, 'target'), 'id'), findings, {
      max: 128,
      pattern: HOST_REFERENCE_PATTERN,
      code: 'PLUGIN_MANIFEST_REFERENCE_INVALID',
    }) &&
    value.kind === 'action_alias' &&
    value.target.id === 'pr.merge'
  ) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
      pointer(pointer(path, 'target'), 'id'),
      'Declarative plugins cannot alias the host merge action.',
    );
  }
  return true;
}

function validateRequires(
  value: unknown,
  path: string,
  findings: ManifestValidationFinding[],
): boolean {
  if (!isRecord(value)) {
    addFinding(findings, 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID', path, 'Expected a requires object.');
    return false;
  }
  checkExactFields(value, ['openslack'], ['openslack'], path, findings);
  checkString(value.openslack, pointer(path, 'openslack'), findings, {
    max: 128,
    pattern: OPENSLACK_VERSION_RANGE_PATTERN,
    code: 'PLUGIN_MANIFEST_VERSION_RANGE_INVALID',
  });
  return true;
}

function validateGate(
  value: unknown,
  path: string,
  findings: ManifestValidationFinding[],
): boolean {
  if (!isRecord(value)) {
    addFinding(findings, 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID', path, 'Expected a gate object.');
    return false;
  }
  checkExactFields(value, ['mode', 'gateId'], ['mode', 'gateId'], path, findings);
  if (!GATE_MODES.has(value.mode)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      pointer(path, 'mode'),
      'Gate mode must be SHADOW or ENFORCE.',
    );
  }
  checkString(value.gateId, pointer(path, 'gateId'), findings, {
    max: 128,
    pattern: HOST_REFERENCE_PATTERN,
    code: 'PLUGIN_MANIFEST_REFERENCE_INVALID',
  });
  return true;
}

function validateCapabilities(
  value: unknown,
  path: string,
  findings: ManifestValidationFinding[],
): DeclarativePluginCapability[] {
  if (!Array.isArray(value)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      path,
      'Expected a capabilities array.',
    );
    return [];
  }
  if (value.length < 1 || value.length > 16) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_CAPABILITY_INVALID',
      path,
      'Capabilities must contain 1 to 16 items.',
    );
  }
  const seen = new Set<string>();
  const capabilities: DeclarativePluginCapability[] = [];
  value.forEach((capability, index) => {
    if (!isDeclarativePluginCapability(capability)) {
      addFinding(
        findings,
        'PLUGIN_MANIFEST_CAPABILITY_INVALID',
        pointer(path, index),
        'Capability is not in the declarative v1 allowlist.',
      );
      return;
    }
    if (seen.has(capability)) {
      addFinding(
        findings,
        'PLUGIN_MANIFEST_CAPABILITY_INVALID',
        pointer(path, index),
        'Capability entries must be unique.',
      );
      return;
    }
    seen.add(capability);
    capabilities.push(capability);
  });
  return capabilities;
}

function validateContributions(
  value: unknown,
  path: string,
  findings: ManifestValidationFinding[],
): DeclarativeContributionV1[] {
  if (!Array.isArray(value)) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
      path,
      'Expected a contributes array.',
    );
    return [];
  }
  if (value.length < 1 || value.length > 64) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_CONTRIBUTION_INVALID',
      path,
      'Contributes must contain 1 to 64 items.',
    );
  }
  const contributions: DeclarativeContributionV1[] = [];
  value.forEach((contribution, index) => {
    if (validateContribution(contribution, pointer(path, index), findings)) {
      contributions.push(contribution);
    }
  });
  return contributions;
}

export function validatePluginManifest(value: unknown): PluginManifestValidationResult {
  const findings: ManifestValidationFinding[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      findings: [
        {
          severity: 'error',
          code: 'PLUGIN_MANIFEST_NOT_OBJECT',
          path: '',
          message: 'Plugin manifest must be a plain JSON object.',
        },
      ],
    };
  }

  const jsonIssue = inspectJsonValue(value, '', new WeakSet<object>());
  if (jsonIssue) {
    return {
      valid: false,
      findings: [
        {
          severity: 'error',
          code: 'PLUGIN_MANIFEST_FIELD_TYPE_INVALID',
          path: jsonIssue.path,
          message: jsonIssue.message,
        },
      ],
    };
  }

  checkExactFields(value, ROOT_FIELDS, REQUIRED_ROOT_FIELDS, '', findings);
  if (value.schema !== PLUGIN_MANIFEST_SCHEMA) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_SCHEMA_UNSUPPORTED',
      '/schema',
      `Manifest schema must be ${PLUGIN_MANIFEST_SCHEMA}.`,
    );
  }
  if (
    checkString(value.id, '/id', findings, {
      max: 64,
      pattern: PLUGIN_ID_PATTERN,
      code: 'PLUGIN_MANIFEST_ID_INVALID',
    })
  ) {
    if (value.id.startsWith('openslack-') || RESERVED_IDS.has(value.id)) {
      addFinding(
        findings,
        'PLUGIN_MANIFEST_ID_RESERVED',
        '/id',
        `Plugin ID "${value.id}" is reserved by the host.`,
      );
    }
  }
  checkString(value.version, '/version', findings, {
    max: 128,
    pattern: MANIFEST_SEMVER_PATTERN,
    code: 'PLUGIN_MANIFEST_VERSION_INVALID',
  });
  checkString(value.name, '/name', findings, { max: 120 });
  if (Object.hasOwn(value, 'description')) {
    checkString(value.description, '/description', findings, { max: 512 });
  }
  validateRequires(value.requires, '/requires', findings);
  validateGate(value.gate, '/gate', findings);
  const capabilities = validateCapabilities(value.capabilities, '/capabilities', findings);
  const contributions = validateContributions(value.contributes, '/contributes', findings);

  if (
    contributions.some((contribution) => contribution.kind === 'action_alias') &&
    !capabilities.includes('host.actions.read')
  ) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_CAPABILITY_INVALID',
      '/capabilities',
      'Action aliases require the host.actions.read capability request.',
    );
  }
  if (
    contributions.some((contribution) => contribution.kind === 'workflow_alias') &&
    !capabilities.includes('host.workflows.read')
  ) {
    addFinding(
      findings,
      'PLUGIN_MANIFEST_CAPABILITY_INVALID',
      '/capabilities',
      'Workflow aliases require the host.workflows.read capability request.',
    );
  }

  if (findings.length > 0) {
    findings.sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.code.localeCompare(b.code) ||
        a.message.localeCompare(b.message),
    );
    return { valid: false, findings };
  }
  return { valid: true, manifest: value as unknown as PluginManifestV1, findings: [] };
}

export function isPluginManifestV1(value: unknown): value is PluginManifestV1 {
  return validatePluginManifest(value).valid;
}

export class PluginManifestValidationError extends Error {
  readonly findings: readonly ManifestValidationFinding[];

  constructor(findings: readonly ManifestValidationFinding[]) {
    super(
      `Plugin manifest is invalid (${findings.length} finding${findings.length === 1 ? '' : 's'}).`,
    );
    this.name = 'PluginManifestValidationError';
    this.findings = findings;
  }
}

export function assertPluginManifestV1(value: unknown): asserts value is PluginManifestV1 {
  const result = validatePluginManifest(value);
  if (!result.valid) throw new PluginManifestValidationError(result.findings);
}

export function declarativeCapabilityValues(): readonly DeclarativePluginCapability[] {
  return [...DECLARATIVE_PLUGIN_CAPABILITIES];
}
