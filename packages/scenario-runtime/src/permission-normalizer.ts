import {
  assertCanonicalCapabilityId,
  isNonOverridableForbiddenCapability,
  ScenarioCapabilityError,
} from './capabilities.js';

export interface ScenarioWorkflowPermissions {
  readonly github?: readonly string[];
  readonly git?: readonly string[];
  readonly filesystem?: readonly string[];
  readonly openslack?: readonly string[];
  readonly capabilities?: readonly string[];
}

const LEGACY_NAMESPACES = Object.freeze(['github', 'git', 'filesystem', 'openslack'] as const);
type LegacyNamespace = (typeof LEGACY_NAMESPACES)[number];

const KNOWN_LEGACY_ALIASES = Object.freeze(
  new Map<string, string>([
    ['github.issues.read', 'github.issues.read'],
    ['github.issues.create', 'github.issues.create'],
    ['github.issues.write', 'github.issues.write'],
    ['github.prs.read', 'github.prs.read'],
    ['github.prs.create', 'github.prs.create'],
    ['github.prs.write', 'github.prs.write'],
    ['github.contents.read', 'github.contents.read'],
    ['github.contents.write', 'github.contents.write'],
    ['github.pull_requests.create', 'github.prs.create'],
    ['github.pr.approve', 'github.pr.approve'],
    ['github.pr.merge', 'github.pr.merge'],
    ['git.branch.create', 'git.branch.create'],
    ['git.branch.write', 'git.branch.write'],
    ['git.push', 'git.push'],
    ['filesystem.workspace.write', 'filesystem.workspace.write'],
    ['filesystem.write', 'filesystem.workspace.write'],
    ['filesystem.delete', 'filesystem.delete'],
    ['filesystem.read', 'filesystem.read'],
    ['openslack.task.create', 'openslack.task.create'],
    ['openslack.task.checkout', 'openslack.task.checkout'],
    ['openslack.task.sync', 'openslack.task.sync'],
    ['openslack.prms.classify', 'openslack.prms.classify'],
    ['openslack.prms.doctor', 'openslack.prms.doctor'],
    ['openslack.prms.queue', 'openslack.prms.queue'],
    ['openslack.prms.requestMerge', 'openslack.prms.requestMerge'],
    ['openslack.collaboration.recordEvent', 'openslack.collaboration.recordEvent'],
    ['openslack.collaboration.createHandoff', 'openslack.collaboration.createHandoff'],
    ['openslack.collaboration.recordDecision', 'openslack.collaboration.recordDecision'],
    ['openslack.governance.audit', 'openslack.governance.audit'],
  ]),
);

function ownDataValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new ScenarioCapabilityError(
      'SCENARIO_CAPABILITY_INVALID',
      'Workflow permission fields must be enumerable own data properties.',
    );
  }
  return descriptor.value;
}

function assertInertPermissionObject(value: unknown): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    throw new ScenarioCapabilityError(
      'SCENARIO_CAPABILITY_INVALID',
      'Workflow permissions must be a plain data object.',
    );
  }
  const allowed = new Set<string>([...LEGACY_NAMESPACES, 'capabilities']);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new ScenarioCapabilityError(
        'SCENARIO_CAPABILITY_INVALID',
        'Workflow permissions contain an unknown namespace.',
      );
    }
    ownDataValue(value, key);
  }
}

function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  if (!Object.hasOwn(record, key)) return [];
  const value = ownDataValue(record, key);
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 128
  ) {
    throw new ScenarioCapabilityError(
      'SCENARIO_CAPABILITY_INVALID',
      `Workflow permission namespace ${key} must be a bounded array.`,
    );
  }
  const result: string[] = [];
  const expected = new Set(['length']);
  for (let index = 0; index < value.length; index += 1) {
    expected.add(String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string'
    ) {
      throw new ScenarioCapabilityError(
        'SCENARIO_CAPABILITY_INVALID',
        `Workflow permission namespace ${key} must contain only strings.`,
      );
    }
    result.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).some((field) => typeof field !== 'string' || !expected.has(field))) {
    throw new ScenarioCapabilityError(
      'SCENARIO_CAPABILITY_INVALID',
      `Workflow permission namespace ${key} contains named or symbol fields.`,
    );
  }
  return result;
}

function normalizeLegacy(namespace: LegacyNamespace, value: string): string {
  if (
    value.length < 1 ||
    value.length > 96 ||
    value.includes('*') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    !/^[A-Za-z][A-Za-z0-9_-]*(?:[.:][A-Za-z][A-Za-z0-9_-]*)*$/.test(value)
  ) {
    throw new ScenarioCapabilityError(
      'SCENARIO_CAPABILITY_INVALID',
      `Legacy ${namespace} permission is malformed.`,
    );
  }
  const canonical = `${namespace}.${value.replaceAll(':', '.')}`;
  const normalized = KNOWN_LEGACY_ALIASES.get(canonical);
  if (!normalized) {
    throw new ScenarioCapabilityError(
      'SCENARIO_CAPABILITY_UNKNOWN',
      `Legacy permission ${namespace}:${value} has no reviewed canonical alias.`,
    );
  }
  return normalized;
}

export function normalizeWorkflowPermissions(
  value: ScenarioWorkflowPermissions | unknown,
  knownCapabilityIds: ReadonlySet<string>,
): readonly string[] {
  assertInertPermissionObject(value);
  const normalized: string[] = [];
  for (const namespace of LEGACY_NAMESPACES) {
    for (const item of readStringArray(value, namespace)) {
      normalized.push(normalizeLegacy(namespace, item));
    }
  }
  for (const item of readStringArray(value, 'capabilities')) {
    assertCanonicalCapabilityId(item);
    normalized.push(item);
  }

  const result = [...new Set(normalized)].sort();
  for (const capability of result) {
    if (isNonOverridableForbiddenCapability(capability)) {
      throw new ScenarioCapabilityError(
        'SCENARIO_CAPABILITY_FORBIDDEN',
        `Capability ${capability} is non-overridable and forbidden.`,
      );
    }
    if (!knownCapabilityIds.has(capability)) {
      throw new ScenarioCapabilityError(
        'SCENARIO_CAPABILITY_UNKNOWN',
        `Capability ${capability} is not present in the sealed host catalog.`,
      );
    }
  }
  return Object.freeze(result);
}
