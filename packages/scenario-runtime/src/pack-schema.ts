import { TextDecoder } from 'node:util';
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Node,
  type Pair,
} from 'yaml';

export const SCENARIO_PACK_SCHEMA = 'openslack.scenario_pack.v1' as const;
export const SCENARIO_PACK_LOCK_SCHEMA = 'openslack.scenario_pack_lock.v1' as const;

export const SCENARIO_PACK_LIMITS = Object.freeze({
  maxFiles: 32,
  maxDirectoryEntries: 64,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxYamlDepth: 12,
  maxYamlNodes: 10_000,
  maxStringLength: 32_768,
  maxFixtureRecords: 500,
});

export type ScenarioYamlValue =
  | null
  | boolean
  | number
  | string
  | ScenarioYamlValue[]
  | { [key: string]: ScenarioYamlValue };

export interface ScenarioPackManifest {
  readonly schema: typeof SCENARIO_PACK_SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly files: readonly string[];
}

export interface ScenarioOntologyType {
  readonly id: string;
  readonly title: string;
  readonly authorityProviders: readonly ('github' | 'openslack' | 'demo_fixture')[];
  readonly fields: readonly string[];
}

export interface ScenarioOntologyRelationship {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface ScenarioOntology {
  readonly schema: 'openslack.scenario_ontology.v1';
  readonly types: readonly ScenarioOntologyType[];
  readonly relationships: readonly ScenarioOntologyRelationship[];
}

export interface ScenarioProjectionReference {
  readonly id: string;
  readonly adapterId: string;
}

export interface ScenarioProjections {
  readonly schema: 'openslack.scenario_projections.v1';
  readonly projectors: readonly ScenarioProjectionReference[];
}

export interface ScenarioWorkflowReference {
  readonly id: string;
  readonly adapterId: string;
  readonly capabilityIds: readonly string[];
  readonly role: string;
}

export interface ScenarioWorkflows {
  readonly schema: 'openslack.scenario_workflows.v1';
  readonly workflows: readonly ScenarioWorkflowReference[];
}

export interface ScenarioCapabilities {
  readonly schema: 'openslack.scenario_capabilities.v1';
  readonly requested: readonly string[];
}

export interface ScenarioPolicies {
  readonly schema: 'openslack.scenario_policies.v1';
  readonly constraints: {
    readonly maxRisk: 'none' | 'low' | 'medium' | 'high';
    readonly allowExternalTargets: boolean;
    readonly maxWorkflowRuns: number;
  };
}

export interface ScenarioView {
  readonly id: string;
  readonly title: string;
  readonly nodeTypes: readonly string[];
  readonly fields: readonly string[];
  readonly deepLinkTemplateId?: string;
  readonly deepLinkArguments?: readonly string[];
}

export interface ScenarioViews {
  readonly schema: 'openslack.scenario_views.v1';
  readonly views: readonly ScenarioView[];
}

export interface ScenarioNotificationMapping {
  readonly eventType: string;
  readonly intentType: string;
}

export interface ScenarioNotifications {
  readonly schema: 'openslack.scenario_notifications.v1';
  readonly mappings: readonly ScenarioNotificationMapping[];
}

export interface ScenarioFixtureRecord {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status?: string;
  readonly properties: Readonly<Record<string, ScenarioYamlValue>>;
}

export interface ScenarioFixture {
  readonly schema: 'openslack.scenario_fixture.v1';
  readonly id: string;
  readonly provenance: 'demo_fixture';
  readonly semanticVersion: string;
  readonly records: readonly ScenarioFixtureRecord[];
}

export interface ScenarioPackLockEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ScenarioPackLock {
  readonly schema: typeof SCENARIO_PACK_LOCK_SCHEMA;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly files: readonly ScenarioPackLockEntry[];
}

export interface ParsedScenarioPackFiles {
  readonly manifest: ScenarioPackManifest;
  readonly ontology: ScenarioOntology;
  readonly projections: ScenarioProjections;
  readonly workflows: ScenarioWorkflows;
  readonly capabilities: ScenarioCapabilities;
  readonly policies: ScenarioPolicies;
  readonly views: ScenarioViews;
  readonly notifications: ScenarioNotifications;
  readonly fixtures: readonly ScenarioFixture[];
}

export type ScenarioPackErrorCode =
  | 'SCENARIO_PACK_UTF8_INVALID'
  | 'SCENARIO_PACK_BOM_FORBIDDEN'
  | 'SCENARIO_PACK_YAML_INVALID'
  | 'SCENARIO_PACK_YAML_LIMIT_EXCEEDED'
  | 'SCENARIO_PACK_SCHEMA_INVALID'
  | 'SCENARIO_PACK_FORBIDDEN_CONTENT';

export class ScenarioPackSchemaError extends Error {
  readonly code: ScenarioPackErrorCode;
  readonly path: string;

  constructor(code: ScenarioPackErrorCode, path: string, message: string) {
    super(message);
    this.name = 'ScenarioPackSchemaError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: ScenarioPackErrorCode, path: string, message: string): never {
  throw new ScenarioPackSchemaError(code, path, message);
}

function decodeYaml(bytes: Buffer, file: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return fail('SCENARIO_PACK_BOM_FORBIDDEN', file, 'UTF-8 BOM is forbidden.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('SCENARIO_PACK_UTF8_INVALID', file, 'Scenario Pack file is not valid UTF-8.');
  }
}

function inspectYamlNode(
  node: Node | Pair | null,
  file: string,
  depth: number,
  state: { nodes: number },
): void {
  if (node === null) return;
  state.nodes += 1;
  if (
    depth > SCENARIO_PACK_LIMITS.maxYamlDepth ||
    state.nodes > SCENARIO_PACK_LIMITS.maxYamlNodes
  ) {
    fail('SCENARIO_PACK_YAML_LIMIT_EXCEEDED', file, 'YAML depth or node limit exceeded.');
  }
  if (isAlias(node)) {
    fail('SCENARIO_PACK_YAML_INVALID', file, 'YAML aliases and anchors are forbidden.');
  }
  if ('anchor' in node && typeof node.anchor === 'string') {
    fail('SCENARIO_PACK_YAML_INVALID', file, 'YAML anchors are forbidden.');
  }
  if ('tag' in node && typeof node.tag === 'string' && !node.tag.startsWith('tag:yaml.org,2002:')) {
    fail('SCENARIO_PACK_YAML_INVALID', file, 'Custom YAML tags are forbidden.');
  }
  if (isMap(node)) {
    for (const item of node.items) inspectYamlNode(item, file, depth + 1, state);
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      inspectYamlNode(item as Node | Pair | null, file, depth + 1, state);
    }
    return;
  }
  if ('key' in node && 'value' in node) {
    const pair = node as Pair;
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      fail('SCENARIO_PACK_YAML_INVALID', file, 'YAML mapping keys must be scalar strings.');
    }
    if (pair.key.value === '<<') {
      fail('SCENARIO_PACK_YAML_INVALID', file, 'YAML merge keys are forbidden.');
    }
    inspectYamlNode(pair.key, file, depth + 1, state);
    inspectYamlNode(pair.value as Node | Pair | null, file, depth + 1, state);
  }
}

function parseYaml(bytes: Buffer, file: string): ScenarioYamlValue {
  const text = decodeYaml(bytes, file);
  let document: Document.Parsed;
  try {
    document = parseDocument(text, {
      customTags: [],
      logLevel: 'silent',
      merge: false,
      prettyErrors: false,
      resolveKnownTags: false,
      schema: 'core',
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
  } catch {
    return fail('SCENARIO_PACK_YAML_INVALID', file, 'Scenario Pack YAML could not be parsed.');
  }
  if (document.errors.length > 0 || document.warnings.length > 0 || !document.contents) {
    return fail(
      'SCENARIO_PACK_YAML_INVALID',
      file,
      'Scenario Pack YAML contains invalid, duplicate, or unsupported syntax.',
    );
  }
  inspectYamlNode(document.contents, file, 1, { nodes: 0 });
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    return fail('SCENARIO_PACK_YAML_INVALID', file, 'YAML aliases are forbidden.');
  }
  assertInertJson(value, file, 1, { nodes: 0 });
  return value as ScenarioYamlValue;
}

const FORBIDDEN_FIELD_NAMES = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'command',
  'cmd',
  'commandline',
  'rawcommand',
  'raw_command',
  'argv',
  'args',
  'shell',
  'exec',
  'spawn',
  'module',
  'modulepath',
  'dynamicimport',
  'require',
  'eval',
  'sourcecode',
  'package',
  'entrypoint',
  'entry',
  'executablepath',
  'main',
  'exports',
  'bin',
  'sourcepath',
  'filepath',
  'url',
  'uri',
  'endpoint',
  'redirect',
  'webhook',
  'credential',
  'credentials',
  'credentialref',
  'authref',
  'vaultref',
  'connectionstring',
  'secret',
  'secretref',
  'password',
  'token',
  'tokenref',
  'githubtoken',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'bearer',
  'apikey',
  'apikeyref',
  'privatekey',
  'approval',
  'approved',
  'approvaldecision',
  'isapproved',
  'approvedby',
  'approvedat',
  'reviewdecision',
  'merge',
  'merged',
  'mergedecision',
  'mergeable',
  'trust',
  'trustlevel',
  'codeowners',
  'identity',
  'actor',
  'grant',
  'grants',
  'permissions',
  'register',
  'registration',
  'script',
  'expression',
  'evaluator',
  'component',
  'html',
  'ui',
  'template',
]);

const URL_PATTERN = /\b(?:https?|ftp|file|data|javascript):/i;
const CREDENTIAL_VALUE_PATTERN =
  /-----BEGIN [A-Z ]+PRIVATE KEY-----|\b(?:password|secret|token|api[_-]?key)\s*[:=]|\$\{[^}]*?(?:TOKEN|SECRET|PASSWORD|KEY)[^}]*\}|(?:^|\s)(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[a-z]-[A-Za-z0-9-]{16,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._-]{16,})/i;
const EXECUTABLE_VALUE_PATTERN =
  /(?:^|[/\\])[^/\\]+\.(?:js|cjs|mjs|ts|tsx|wasm|exe|dll|so|dylib|sh|bash|ps1|cmd|bat)$/i;

function assertInertJson(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number },
): void {
  state.nodes += 1;
  if (
    depth > SCENARIO_PACK_LIMITS.maxYamlDepth ||
    state.nodes > SCENARIO_PACK_LIMITS.maxYamlNodes
  ) {
    fail('SCENARIO_PACK_YAML_LIMIT_EXCEEDED', path, 'Parsed data exceeds its structural limit.');
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > SCENARIO_PACK_LIMITS.maxStringLength) {
      fail('SCENARIO_PACK_YAML_LIMIT_EXCEEDED', path, 'String exceeds its byte-safe limit.');
    }
    if (
      URL_PATTERN.test(value) ||
      CREDENTIAL_VALUE_PATTERN.test(value) ||
      EXECUTABLE_VALUE_PATTERN.test(value)
    ) {
      fail(
        'SCENARIO_PACK_FORBIDDEN_CONTENT',
        path,
        'URL, credential, or executable references are forbidden.',
      );
    }
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('SCENARIO_PACK_SCHEMA_INVALID', path, 'Non-finite numbers are forbidden.');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 2_000) {
      fail('SCENARIO_PACK_YAML_LIMIT_EXCEEDED', path, 'Array is not bounded plain data.');
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('SCENARIO_PACK_SCHEMA_INVALID', path, 'Sparse or accessor arrays are forbidden.');
      }
      assertInertJson(descriptor.value, `${path}/${index}`, depth + 1, state);
    }
    return;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    fail('SCENARIO_PACK_SCHEMA_INVALID', path, 'Only plain data objects are accepted.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128) {
    fail('SCENARIO_PACK_YAML_LIMIT_EXCEEDED', path, 'Object field limit exceeded.');
  }
  for (const key of keys) {
    if (
      typeof key !== 'string' ||
      Buffer.byteLength(key, 'utf8') > 128 ||
      /[\u0000-\u001f\u007f]/.test(key)
    ) {
      fail('SCENARIO_PACK_SCHEMA_INVALID', path, 'Symbol fields are forbidden.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('SCENARIO_PACK_SCHEMA_INVALID', `${path}/${key}`, 'Accessor fields are forbidden.');
    }
    const normalizedKey = key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
    if (
      FORBIDDEN_FIELD_NAMES.has(normalizedKey) ||
      /(?:password|credential|privatekey|accesstoken|refreshtoken|githubtoken|tokenref|apikey|apikeyref|secret|authref|vaultref|connectionstring)$/.test(
        normalizedKey,
      )
    ) {
      fail(
        'SCENARIO_PACK_FORBIDDEN_CONTENT',
        `${path}/${key}`,
        'Executable, authority, credential, or dynamic UI fields are forbidden.',
      );
    }
    assertInertJson(descriptor.value, `${path}/${key}`, depth + 1, state);
  }
}

type DataRecord = Record<string, ScenarioYamlValue>;

function asRecord(value: ScenarioYamlValue, path: string): DataRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('SCENARIO_PACK_SCHEMA_INVALID', path, 'Expected a mapping.');
  }
  return value;
}

function exactFields(
  value: DataRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      fail('SCENARIO_PACK_SCHEMA_INVALID', `${path}/${field}`, 'Required field is missing.');
    }
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail('SCENARIO_PACK_SCHEMA_INVALID', `${path}/${field}`, 'Unknown field is forbidden.');
    }
  }
}

function stringField(
  value: DataRecord,
  key: string,
  path: string,
  pattern = /^[A-Za-z][A-Za-z0-9_.:-]*$/,
  max = 160,
): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length < 1 || field.length > max || !pattern.test(field)) {
    return fail('SCENARIO_PACK_SCHEMA_INVALID', `${path}/${key}`, 'String field is invalid.');
  }
  return field;
}

function stringArray(
  value: ScenarioYamlValue,
  path: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < (options.min ?? 0) ||
    value.length > (options.max ?? 128)
  ) {
    return fail('SCENARIO_PACK_SCHEMA_INVALID', path, 'Expected a bounded string array.');
  }
  const pattern = options.pattern ?? /^[A-Za-z][A-Za-z0-9_.:-]*$/;
  const result = value.map((item, index) => {
    if (typeof item !== 'string' || item.length < 1 || item.length > 160 || !pattern.test(item)) {
      return fail('SCENARIO_PACK_SCHEMA_INVALID', `${path}/${index}`, 'Array value is invalid.');
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    fail('SCENARIO_PACK_SCHEMA_INVALID', path, 'Duplicate array values are forbidden.');
  }
  return Object.freeze(result);
}

function objectArray(value: ScenarioYamlValue, path: string, max: number): readonly DataRecord[] {
  if (!Array.isArray(value) || value.length > max) {
    return fail('SCENARIO_PACK_SCHEMA_INVALID', path, 'Expected a bounded object array.');
  }
  return value.map((item, index) => asRecord(item, `${path}/${index}`));
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(freeze);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freeze);
  }
  return Object.freeze(value);
}

const TYPE_ID = /^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9_]*)*$/;
const RELATIONSHIP_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PROPERTY_ID = /^[a-z][A-Za-z0-9]*$/;
const STATUS_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const HOST_REFERENCE_ID = /^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)*$/;
const FILE =
  /^(?:scenario|ontology|projections|workflows|capabilities|policies|views|notifications)\.yaml$|^fixtures\/[a-z][a-z0-9-]*\.yaml$/;
const SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isCanonicalScenarioSemver(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && SEMVER.test(value);
}

export function parseScenarioManifest(bytes: Buffer): ScenarioPackManifest {
  const value = asRecord(parseYaml(bytes, 'scenario.yaml'), 'scenario.yaml');
  exactFields(
    value,
    ['schema', 'id', 'version', 'title', 'description', 'files'],
    [],
    'scenario.yaml',
  );
  if (value.schema !== SCENARIO_PACK_SCHEMA) {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'scenario.yaml/schema',
      'Pack schema is unsupported.',
    );
  }
  const files = stringArray(value.files, 'scenario.yaml/files', {
    min: 8,
    max: SCENARIO_PACK_LIMITS.maxFiles,
    pattern: FILE,
  });
  if (
    !files.includes('scenario.yaml') ||
    [...files].sort().some((item, index) => item !== files[index])
  ) {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'scenario.yaml/files',
      'Declared files must be sorted and include scenario.yaml.',
    );
  }
  return freeze({
    schema: SCENARIO_PACK_SCHEMA,
    id: stringField(value, 'id', 'scenario.yaml', /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 64),
    version: stringField(value, 'version', 'scenario.yaml', SEMVER, 128),
    title: stringField(value, 'title', 'scenario.yaml', /^.{1,160}$/u, 160),
    description: stringField(value, 'description', 'scenario.yaml', /^[\s\S]{1,2000}$/u, 2000),
    files,
  });
}

function parseOntology(bytes: Buffer): ScenarioOntology {
  const value = asRecord(parseYaml(bytes, 'ontology.yaml'), 'ontology.yaml');
  exactFields(value, ['schema', 'types', 'relationships'], [], 'ontology.yaml');
  if (value.schema !== 'openslack.scenario_ontology.v1') {
    return fail('SCENARIO_PACK_SCHEMA_INVALID', 'ontology.yaml/schema', 'Schema is unsupported.');
  }
  const types = objectArray(value.types, 'ontology.yaml/types', 64).map((item, index) => {
    const path = `ontology.yaml/types/${index}`;
    exactFields(item, ['id', 'title', 'authorityProviders', 'fields'], [], path);
    const authorityProviders = stringArray(item.authorityProviders, `${path}/authorityProviders`, {
      max: 3,
      pattern: /^(?:github|openslack|demo_fixture)$/,
    });
    if (authorityProviders.length < 1) {
      return fail(
        'SCENARIO_PACK_SCHEMA_INVALID',
        `${path}/authorityProviders`,
        'At least one authority provider is required.',
      );
    }
    return {
      id: stringField(item, 'id', path, TYPE_ID),
      title: stringField(item, 'title', path, /^.{1,160}$/u),
      authorityProviders: authorityProviders as ScenarioOntologyType['authorityProviders'],
      fields: stringArray(item.fields, `${path}/fields`, { max: 64, pattern: PROPERTY_ID }),
    };
  });
  const typeIds = new Set(types.map((type) => type.id));
  if (typeIds.size !== types.length) {
    return fail('SCENARIO_PACK_SCHEMA_INVALID', 'ontology.yaml/types', 'Type IDs must be unique.');
  }
  const relationships = objectArray(value.relationships, 'ontology.yaml/relationships', 128).map(
    (item, index) => {
      const path = `ontology.yaml/relationships/${index}`;
      exactFields(item, ['id', 'from', 'to'], [], path);
      const result = {
        id: stringField(item, 'id', path, RELATIONSHIP_ID),
        from: stringField(item, 'from', path, TYPE_ID),
        to: stringField(item, 'to', path, TYPE_ID),
      };
      if (!typeIds.has(result.from) || !typeIds.has(result.to)) {
        return fail(
          'SCENARIO_PACK_SCHEMA_INVALID',
          path,
          'Relationship type reference is missing.',
        );
      }
      return result;
    },
  );
  if (
    new Set(relationships.map((item) => `${item.id}\0${item.from}\0${item.to}`)).size !==
    relationships.length
  ) {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'ontology.yaml/relationships',
      'Relationship endpoint declarations must be unique.',
    );
  }
  return freeze({ schema: 'openslack.scenario_ontology.v1', types, relationships });
}

function parseProjections(bytes: Buffer): ScenarioProjections {
  const value = asRecord(parseYaml(bytes, 'projections.yaml'), 'projections.yaml');
  exactFields(value, ['schema', 'projectors'], [], 'projections.yaml');
  if (value.schema !== 'openslack.scenario_projections.v1') {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'projections.yaml/schema',
      'Schema is unsupported.',
    );
  }
  const projectors = objectArray(value.projectors, 'projections.yaml/projectors', 16).map(
    (item, index) => {
      const path = `projections.yaml/projectors/${index}`;
      exactFields(item, ['id', 'adapterId'], [], path);
      return {
        id: stringField(item, 'id', path, HOST_REFERENCE_ID),
        adapterId: stringField(item, 'adapterId', path, HOST_REFERENCE_ID),
      };
    },
  );
  if (new Set(projectors.map((item) => item.id)).size !== projectors.length) {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'projections.yaml/projectors',
      'Projector IDs must be unique.',
    );
  }
  return freeze({ schema: 'openslack.scenario_projections.v1', projectors });
}

function parseWorkflows(bytes: Buffer): ScenarioWorkflows {
  const value = asRecord(parseYaml(bytes, 'workflows.yaml'), 'workflows.yaml');
  exactFields(value, ['schema', 'workflows'], [], 'workflows.yaml');
  if (value.schema !== 'openslack.scenario_workflows.v1') {
    return fail('SCENARIO_PACK_SCHEMA_INVALID', 'workflows.yaml/schema', 'Schema is unsupported.');
  }
  const workflows = objectArray(value.workflows, 'workflows.yaml/workflows', 32).map(
    (item, index) => {
      const path = `workflows.yaml/workflows/${index}`;
      exactFields(item, ['id', 'adapterId', 'capabilityIds', 'role'], [], path);
      return {
        id: stringField(item, 'id', path, HOST_REFERENCE_ID),
        adapterId: stringField(item, 'adapterId', path, HOST_REFERENCE_ID),
        capabilityIds: stringArray(item.capabilityIds, `${path}/capabilityIds`, {
          max: 64,
          pattern: HOST_REFERENCE_ID,
        }),
        role: stringField(item, 'role', path, STATUS_ID),
      };
    },
  );
  if (new Set(workflows.map((item) => item.id)).size !== workflows.length) {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'workflows.yaml/workflows',
      'Workflow IDs must be unique.',
    );
  }
  return freeze({ schema: 'openslack.scenario_workflows.v1', workflows });
}

function parseCapabilities(bytes: Buffer): ScenarioCapabilities {
  const value = asRecord(parseYaml(bytes, 'capabilities.yaml'), 'capabilities.yaml');
  exactFields(value, ['schema', 'requested'], [], 'capabilities.yaml');
  if (value.schema !== 'openslack.scenario_capabilities.v1') {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'capabilities.yaml/schema',
      'Schema is unsupported.',
    );
  }
  return freeze({
    schema: 'openslack.scenario_capabilities.v1',
    requested: stringArray(value.requested, 'capabilities.yaml/requested', {
      max: 128,
      pattern: HOST_REFERENCE_ID,
    }),
  });
}

function parsePolicies(bytes: Buffer): ScenarioPolicies {
  const value = asRecord(parseYaml(bytes, 'policies.yaml'), 'policies.yaml');
  exactFields(value, ['schema', 'constraints'], [], 'policies.yaml');
  if (value.schema !== 'openslack.scenario_policies.v1') {
    return fail('SCENARIO_PACK_SCHEMA_INVALID', 'policies.yaml/schema', 'Schema is unsupported.');
  }
  const constraints = asRecord(value.constraints, 'policies.yaml/constraints');
  exactFields(
    constraints,
    ['maxRisk', 'allowExternalTargets', 'maxWorkflowRuns'],
    [],
    'policies.yaml/constraints',
  );
  const maxRisk = stringField(constraints, 'maxRisk', 'policies.yaml/constraints');
  if (!['none', 'low', 'medium', 'high'].includes(maxRisk)) {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'policies.yaml/constraints/maxRisk',
      'Risk is invalid.',
    );
  }
  if (
    typeof constraints.allowExternalTargets !== 'boolean' ||
    !Number.isSafeInteger(constraints.maxWorkflowRuns) ||
    (constraints.maxWorkflowRuns as number) < 1 ||
    (constraints.maxWorkflowRuns as number) > 32
  ) {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'policies.yaml/constraints',
      'Constraint is invalid.',
    );
  }
  return freeze({
    schema: 'openslack.scenario_policies.v1',
    constraints: {
      maxRisk: maxRisk as ScenarioPolicies['constraints']['maxRisk'],
      allowExternalTargets: constraints.allowExternalTargets,
      maxWorkflowRuns: constraints.maxWorkflowRuns as number,
    },
  });
}

function parseViews(bytes: Buffer): ScenarioViews {
  const value = asRecord(parseYaml(bytes, 'views.yaml'), 'views.yaml');
  exactFields(value, ['schema', 'views'], [], 'views.yaml');
  if (value.schema !== 'openslack.scenario_views.v1') {
    return fail('SCENARIO_PACK_SCHEMA_INVALID', 'views.yaml/schema', 'Schema is unsupported.');
  }
  const views = objectArray(value.views, 'views.yaml/views', 32).map((item, index) => {
    const path = `views.yaml/views/${index}`;
    exactFields(
      item,
      ['id', 'title', 'nodeTypes', 'fields'],
      ['deepLinkTemplateId', 'deepLinkArguments'],
      path,
    );
    if ((item.deepLinkTemplateId === undefined) !== (item.deepLinkArguments === undefined)) {
      return fail(
        'SCENARIO_PACK_SCHEMA_INVALID',
        path,
        'View deep-link template and arguments must be declared together.',
      );
    }
    return {
      id: stringField(item, 'id', path, STATUS_ID),
      title: stringField(item, 'title', path, /^.{1,160}$/u),
      nodeTypes: stringArray(item.nodeTypes, `${path}/nodeTypes`, {
        max: 64,
        pattern: TYPE_ID,
      }),
      fields: stringArray(item.fields, `${path}/fields`, { max: 64, pattern: PROPERTY_ID }),
      ...(item.deepLinkTemplateId === undefined
        ? {}
        : {
            deepLinkTemplateId: stringField(item, 'deepLinkTemplateId', path, HOST_REFERENCE_ID),
            deepLinkArguments: stringArray(item.deepLinkArguments, `${path}/deepLinkArguments`, {
              max: 16,
              pattern: PROPERTY_ID,
            }),
          }),
    };
  });
  if (new Set(views.map((item) => item.id)).size !== views.length) {
    return fail('SCENARIO_PACK_SCHEMA_INVALID', 'views.yaml/views', 'View IDs must be unique.');
  }
  return freeze({ schema: 'openslack.scenario_views.v1', views });
}

function parseNotifications(bytes: Buffer): ScenarioNotifications {
  const value = asRecord(parseYaml(bytes, 'notifications.yaml'), 'notifications.yaml');
  exactFields(value, ['schema', 'mappings'], [], 'notifications.yaml');
  if (value.schema !== 'openslack.scenario_notifications.v1') {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'notifications.yaml/schema',
      'Schema is unsupported.',
    );
  }
  const mappings = objectArray(value.mappings, 'notifications.yaml/mappings', 32).map(
    (item, index) => {
      const path = `notifications.yaml/mappings/${index}`;
      exactFields(item, ['eventType', 'intentType'], [], path);
      return {
        eventType: stringField(item, 'eventType', path, TYPE_ID),
        intentType: stringField(item, 'intentType', path, HOST_REFERENCE_ID),
      };
    },
  );
  if (new Set(mappings.map((item) => item.eventType)).size !== mappings.length) {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      'notifications.yaml/mappings',
      'Notification event mappings must be unique.',
    );
  }
  return freeze({ schema: 'openslack.scenario_notifications.v1', mappings });
}

function parseFixture(bytes: Buffer, file: string): ScenarioFixture {
  const value = asRecord(parseYaml(bytes, file), file);
  exactFields(value, ['schema', 'id', 'provenance', 'semanticVersion', 'records'], [], file);
  if (value.schema !== 'openslack.scenario_fixture.v1' || value.provenance !== 'demo_fixture') {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      file,
      'Fixture schema and demo_fixture provenance are mandatory.',
    );
  }
  const records = objectArray(
    value.records,
    `${file}/records`,
    SCENARIO_PACK_LIMITS.maxFixtureRecords,
  ).map((item, index) => {
    const path = `${file}/records/${index}`;
    exactFields(item, ['id', 'type', 'title', 'properties'], ['status'], path);
    return {
      id: stringField(item, 'id', path, STATUS_ID),
      type: stringField(item, 'type', path, TYPE_ID),
      title: stringField(item, 'title', path, /^.{1,160}$/u),
      ...(item.status === undefined
        ? {}
        : { status: stringField(item, 'status', path, STATUS_ID) }),
      properties: asRecord(item.properties, `${path}/properties`),
    };
  });
  if (new Set(records.map((item) => item.id)).size !== records.length) {
    return fail(
      'SCENARIO_PACK_SCHEMA_INVALID',
      `${file}/records`,
      'Fixture record IDs must be unique.',
    );
  }
  return freeze({
    schema: 'openslack.scenario_fixture.v1',
    id: stringField(value, 'id', file, STATUS_ID),
    provenance: 'demo_fixture',
    semanticVersion: stringField(value, 'semanticVersion', file, SEMVER, 128),
    records,
  });
}

export function parseScenarioPackFiles(
  bytes: ReadonlyMap<string, Buffer>,
  manifest: ScenarioPackManifest,
): ParsedScenarioPackFiles {
  const requireBytes = (path: string): Buffer => {
    const value = bytes.get(path);
    if (!value) return fail('SCENARIO_PACK_SCHEMA_INVALID', path, 'Declared file is missing.');
    return value;
  };
  const fixturePaths = manifest.files.filter((path) => path.startsWith('fixtures/'));
  return freeze({
    manifest,
    ontology: parseOntology(requireBytes('ontology.yaml')),
    projections: parseProjections(requireBytes('projections.yaml')),
    workflows: parseWorkflows(requireBytes('workflows.yaml')),
    capabilities: parseCapabilities(requireBytes('capabilities.yaml')),
    policies: parsePolicies(requireBytes('policies.yaml')),
    views: parseViews(requireBytes('views.yaml')),
    notifications: parseNotifications(requireBytes('notifications.yaml')),
    fixtures: fixturePaths.map((path) => parseFixture(requireBytes(path), path)),
  });
}
