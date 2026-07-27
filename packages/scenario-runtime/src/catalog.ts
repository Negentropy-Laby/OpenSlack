import {
  assertCanonicalCapabilityId,
  type CapabilityCatalogEntry,
  isNonOverridableForbiddenCapability,
  SCENARIO_RISK_LEVELS,
} from './capabilities.js';
import { isCanonicalScenarioSemver } from './pack-schema.js';
import {
  SOFTWARE_DELIVERY_PROJECTOR_CONTRACT,
  SOFTWARE_DELIVERY_PROJECTOR_ID,
} from '@openslack/organization-graph';
import { types as nodeTypes } from 'node:util';

const CATALOG_ID_PATTERN = /^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)*$/;
const CATALOG_INPUT_FIELDS = Object.freeze([
  'projectors',
  'workflows',
  'capabilities',
  'adapters',
  'deepLinkTemplates',
  'notificationIntents',
] as const);

export interface ScenarioProjectorCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly adapterId: string;
  readonly nodeTypes: readonly string[];
  readonly edgeTypes: readonly string[];
}

export interface ScenarioWorkflowCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly adapterId: string;
  readonly capabilityIds: readonly string[];
}

export interface ScenarioAdapterCatalogEntry {
  readonly id: string;
  readonly kind: 'projection' | 'workflow' | 'notification' | 'deep_link';
  readonly capabilityIds: readonly string[];
}

export interface ScenarioDeepLinkCatalogEntry {
  readonly id: string;
  readonly allowedArgumentNames: readonly string[];
}

export interface ScenarioNotificationIntentCatalogEntry {
  readonly id: string;
}

export interface ScenarioHostCatalogInput {
  readonly projectors: readonly ScenarioProjectorCatalogEntry[];
  readonly workflows: readonly ScenarioWorkflowCatalogEntry[];
  readonly capabilities: readonly CapabilityCatalogEntry[];
  readonly adapters: readonly ScenarioAdapterCatalogEntry[];
  readonly deepLinkTemplates: readonly ScenarioDeepLinkCatalogEntry[];
  readonly notificationIntents: readonly ScenarioNotificationIntentCatalogEntry[];
}

export class ScenarioCatalogError extends Error {
  readonly code:
    | 'SCENARIO_CATALOG_INVALID'
    | 'SCENARIO_CATALOG_DUPLICATE'
    | 'SCENARIO_CATALOG_REFERENCE_MISSING'
    | 'SCENARIO_CATALOG_SEALED_REQUIRED';

  constructor(code: ScenarioCatalogError['code'], message: string) {
    super(message);
    this.name = 'ScenarioCatalogError';
    this.code = code;
  }
}

function assertCatalogId(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    value.includes('*') ||
    !CATALOG_ID_PATTERN.test(value)
  ) {
    throw new ScenarioCatalogError(
      'SCENARIO_CATALOG_INVALID',
      `${field} must be a bounded canonical identifier.`,
    );
  }
}

function assertVersion(value: unknown, field: string): asserts value is string {
  if (!isCanonicalScenarioSemver(value)) {
    throw new ScenarioCatalogError(
      'SCENARIO_CATALOG_INVALID',
      `${field} must be a canonical semantic version.`,
    );
  }
}

function cloneSortedStrings(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 128) {
    throw new ScenarioCatalogError('SCENARIO_CATALOG_INVALID', `${field} must be a bounded array.`);
  }
  const result = values.map((value) => {
    assertCatalogId(value, field);
    return value;
  });
  if (new Set(result).size !== result.length) {
    throw new ScenarioCatalogError(
      'SCENARIO_CATALOG_DUPLICATE',
      `${field} contains duplicate identifiers.`,
    );
  }
  return Object.freeze(result.sort());
}

function buildUnique<T extends { readonly id: string }>(
  values: readonly T[],
  label: string,
  clone: (value: T) => T,
): ReadonlyMap<string, T> {
  if (!Array.isArray(values) || values.length > 512) {
    throw new ScenarioCatalogError(
      'SCENARIO_CATALOG_INVALID',
      `${label} catalog must be a bounded array.`,
    );
  }
  const result = new Map<string, T>();
  for (const value of values) {
    assertInertCatalogValue(value, `${label} entry`, 1);
    assertCatalogId(value.id, `${label}.id`);
    if (result.has(value.id)) {
      throw new ScenarioCatalogError(
        'SCENARIO_CATALOG_DUPLICATE',
        `${label} catalog contains duplicate ID ${value.id}.`,
      );
    }
    result.set(value.id, Object.freeze(clone(value)));
  }
  return result;
}

function assertInertCatalogValue(value: unknown, field: string, depth: number): void {
  if (depth > 8) {
    throw new ScenarioCatalogError('SCENARIO_CATALOG_INVALID', `${field} exceeds depth limits.`);
  }
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    if (nodeTypes.isProxy(value)) {
      throw new ScenarioCatalogError('SCENARIO_CATALOG_INVALID', `${field} cannot be a Proxy.`);
    }
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 512) {
      throw new ScenarioCatalogError(
        'SCENARIO_CATALOG_INVALID',
        `${field} must be a bounded dense array.`,
      );
    }
    const expected = new Set(['length']);
    for (let index = 0; index < value.length; index += 1) {
      expected.add(String(index));
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new ScenarioCatalogError(
          'SCENARIO_CATALOG_INVALID',
          `${field} contains sparse or accessor array entries.`,
        );
      }
      assertInertCatalogValue(descriptor.value, `${field}/${index}`, depth + 1);
    }
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !expected.has(key))) {
      throw new ScenarioCatalogError(
        'SCENARIO_CATALOG_INVALID',
        `${field} contains named or symbol array fields.`,
      );
    }
    return;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ScenarioCatalogError(
      'SCENARIO_CATALOG_INVALID',
      `${field} entries must be inert plain data.`,
    );
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new ScenarioCatalogError(
        'SCENARIO_CATALOG_INVALID',
        `${field} contains symbol fields.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new ScenarioCatalogError(
        'SCENARIO_CATALOG_INVALID',
        `${field} contains accessor fields.`,
      );
    }
    assertInertCatalogValue(descriptor.value, `${field}/${key}`, depth + 1);
  }
}

function assertClosedCatalogInput(value: unknown): asserts value is ScenarioHostCatalogInput {
  assertInertCatalogValue(value, 'host catalog', 0);
  const keys = Reflect.ownKeys(value as object);
  if (
    keys.length !== CATALOG_INPUT_FIELDS.length ||
    keys.some((key) => typeof key !== 'string' || !CATALOG_INPUT_FIELDS.includes(key as never))
  ) {
    throw new ScenarioCatalogError(
      'SCENARIO_CATALOG_INVALID',
      'Host catalog must contain exactly the six reviewed catalog arrays.',
    );
  }
}

const SEALED_CATALOGS = new WeakSet<object>();

export class ScenarioHostCatalog {
  readonly #projectors: ReadonlyMap<string, ScenarioProjectorCatalogEntry>;
  readonly #workflows: ReadonlyMap<string, ScenarioWorkflowCatalogEntry>;
  readonly #capabilities: ReadonlyMap<string, CapabilityCatalogEntry>;
  readonly #adapters: ReadonlyMap<string, ScenarioAdapterCatalogEntry>;
  readonly #deepLinkTemplates: ReadonlyMap<string, ScenarioDeepLinkCatalogEntry>;
  readonly #notificationIntents: ReadonlyMap<string, ScenarioNotificationIntentCatalogEntry>;

  private constructor(input: ScenarioHostCatalogInput) {
    this.#adapters = buildUnique(input.adapters, 'adapter', (entry) => {
      if (!['projection', 'workflow', 'notification', 'deep_link'].includes(entry.kind)) {
        throw new ScenarioCatalogError('SCENARIO_CATALOG_INVALID', 'Adapter kind is invalid.');
      }
      return {
        id: entry.id,
        kind: entry.kind,
        capabilityIds: cloneSortedStrings(entry.capabilityIds, 'adapter.capabilityIds'),
      };
    });
    this.#capabilities = buildUnique(input.capabilities, 'capability', (entry) => {
      assertCanonicalCapabilityId(entry.id);
      assertCatalogId(entry.adapterId, 'capability.adapterId');
      if (!SCENARIO_RISK_LEVELS.includes(entry.risk)) {
        throw new ScenarioCatalogError('SCENARIO_CATALOG_INVALID', 'Capability risk is invalid.');
      }
      if (
        typeof entry.readOnly !== 'boolean' ||
        typeof entry.approvalRequired !== 'boolean' ||
        (entry.readOnly && entry.approvalRequired)
      ) {
        throw new ScenarioCatalogError(
          'SCENARIO_CATALOG_INVALID',
          'Capability read/approval metadata is inconsistent.',
        );
      }
      return {
        id: entry.id,
        adapterId: entry.adapterId,
        risk: entry.risk,
        readOnly: entry.readOnly,
        approvalRequired: entry.approvalRequired,
      };
    });
    this.#projectors = buildUnique(input.projectors, 'projector', (entry) => {
      assertVersion(entry.version, 'projector.version');
      assertCatalogId(entry.adapterId, 'projector.adapterId');
      return {
        id: entry.id,
        version: entry.version,
        adapterId: entry.adapterId,
        nodeTypes: cloneSortedStrings(entry.nodeTypes, 'projector.nodeTypes'),
        edgeTypes: cloneSortedStrings(entry.edgeTypes, 'projector.edgeTypes'),
      };
    });
    this.#workflows = buildUnique(input.workflows, 'workflow', (entry) => {
      assertVersion(entry.version, 'workflow.version');
      assertCatalogId(entry.adapterId, 'workflow.adapterId');
      return {
        id: entry.id,
        version: entry.version,
        adapterId: entry.adapterId,
        capabilityIds: cloneSortedStrings(entry.capabilityIds, 'workflow.capabilityIds'),
      };
    });
    this.#deepLinkTemplates = buildUnique(
      input.deepLinkTemplates,
      'deep-link template',
      (entry) => ({
        id: entry.id,
        allowedArgumentNames: cloneSortedStrings(
          entry.allowedArgumentNames,
          'deepLinkTemplate.allowedArgumentNames',
        ),
      }),
    );
    this.#notificationIntents = buildUnique(
      input.notificationIntents,
      'notification intent',
      (entry) => ({ id: entry.id }),
    );

    for (const capability of this.#capabilities.values()) {
      if (isNonOverridableForbiddenCapability(capability.id)) {
        throw new ScenarioCatalogError(
          'SCENARIO_CATALOG_INVALID',
          `Forbidden capability ${capability.id} cannot be registered.`,
        );
      }
      const adapter = this.#adapters.get(capability.adapterId);
      if (!adapter || !adapter.capabilityIds.includes(capability.id)) {
        throw new ScenarioCatalogError(
          'SCENARIO_CATALOG_REFERENCE_MISSING',
          `Capability ${capability.id} is not bound by its reviewed adapter.`,
        );
      }
    }
    for (const adapter of this.#adapters.values()) {
      for (const capabilityId of adapter.capabilityIds) {
        const capability = this.#capabilities.get(capabilityId);
        if (!capability || capability.adapterId !== adapter.id) {
          throw new ScenarioCatalogError(
            'SCENARIO_CATALOG_REFERENCE_MISSING',
            `Adapter ${adapter.id} declares an unregistered capability.`,
          );
        }
      }
    }
    for (const projector of this.#projectors.values()) {
      if (this.#adapters.get(projector.adapterId)?.kind !== 'projection') {
        throw new ScenarioCatalogError(
          'SCENARIO_CATALOG_REFERENCE_MISSING',
          `Projector ${projector.id} has no matching projection adapter.`,
        );
      }
    }
    for (const workflow of this.#workflows.values()) {
      if (this.#adapters.get(workflow.adapterId)?.kind !== 'workflow') {
        throw new ScenarioCatalogError(
          'SCENARIO_CATALOG_REFERENCE_MISSING',
          `Workflow ${workflow.id} has no matching workflow adapter.`,
        );
      }
      for (const capabilityId of workflow.capabilityIds) {
        const capability = this.#capabilities.get(capabilityId);
        if (!capability || !this.#adapters.has(capability.adapterId)) {
          throw new ScenarioCatalogError(
            'SCENARIO_CATALOG_REFERENCE_MISSING',
            `Workflow ${workflow.id} references an unavailable reviewed capability.`,
          );
        }
      }
    }
    SEALED_CATALOGS.add(this);
    Object.freeze(this);
  }

  static seal(input: ScenarioHostCatalogInput): ScenarioHostCatalog {
    assertClosedCatalogInput(input);
    return new ScenarioHostCatalog(input);
  }

  static assertSealed(value: unknown): asserts value is ScenarioHostCatalog {
    if (
      typeof value !== 'object' ||
      value === null ||
      !(value instanceof ScenarioHostCatalog) ||
      !SEALED_CATALOGS.has(value)
    ) {
      throw new ScenarioCatalogError(
        'SCENARIO_CATALOG_SEALED_REQUIRED',
        'A host-created, sealed scenario catalog is required.',
      );
    }
  }

  capabilityIds(): ReadonlySet<string> {
    return new Set(this.#capabilities.keys());
  }

  projector(id: string): ScenarioProjectorCatalogEntry | undefined {
    return this.#projectors.get(id);
  }

  workflow(id: string): ScenarioWorkflowCatalogEntry | undefined {
    return this.#workflows.get(id);
  }

  capability(id: string): CapabilityCatalogEntry | undefined {
    return this.#capabilities.get(id);
  }

  adapter(id: string): ScenarioAdapterCatalogEntry | undefined {
    return this.#adapters.get(id);
  }

  deepLinkTemplate(id: string): ScenarioDeepLinkCatalogEntry | undefined {
    return this.#deepLinkTemplates.get(id);
  }

  notificationIntent(id: string): ScenarioNotificationIntentCatalogEntry | undefined {
    return this.#notificationIntents.get(id);
  }
}

export function sealScenarioHostCatalog(input: ScenarioHostCatalogInput): ScenarioHostCatalog {
  return ScenarioHostCatalog.seal(input);
}

/**
 * Minimal reviewed catalog for the QG3 projection-only foundation pack.
 *
 * The ID is imported from the implemented Organization Graph projector rather than inferred from
 * pack content. Mutation adapters, workflows, links, and notification routes remain absent until
 * their composition roots exist in later gates.
 */
export function createSoftwareDeliveryScenarioCatalog(): ScenarioHostCatalog {
  return ScenarioHostCatalog.seal({
    projectors: [
      {
        id: SOFTWARE_DELIVERY_PROJECTOR_ID,
        version: '1.0.0',
        adapterId: SOFTWARE_DELIVERY_PROJECTOR_ID,
        nodeTypes: SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.nodeTypes,
        edgeTypes: SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.edgeTypes,
      },
    ],
    workflows: [],
    capabilities: [],
    adapters: [
      {
        id: SOFTWARE_DELIVERY_PROJECTOR_ID,
        kind: 'projection',
        capabilityIds: [],
      },
    ],
    deepLinkTemplates: [],
    notificationIntents: [],
  });
}
