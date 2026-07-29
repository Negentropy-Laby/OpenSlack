import {
  CONTRACT_TO_DELIVERY_PROJECTOR_ID,
  CONTRACT_TO_DELIVERY_SCENARIO_ID,
  CONTRACT_TO_DELIVERY_SOURCE_LIMITS,
  type ContractToDeliverySourceSnapshot,
} from './contract-to-delivery-types.js';
import { projectContractToDeliverySnapshot } from './contract-to-delivery-projector.js';
import { validateContractToDeliverySourceSnapshot } from './contract-to-delivery-validation.js';
import { GraphContractError } from './errors.js';
import {
  SOFTWARE_DELIVERY_PROJECTOR_ID,
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
  type SoftwareDeliverySourceSnapshot,
} from './software-delivery-types.js';
import { projectSoftwareDeliverySnapshot } from './software-delivery-projector.js';
import { validateSoftwareDeliverySourceSnapshot } from './software-delivery-validation.js';
import { parseStrictGraphJson } from './strict-json.js';
import type { LocalGraphStore, PublishedGraphSnapshot } from './store.js';
import type { GraphSnapshot } from './types.js';

export const SOFTWARE_DELIVERY_SCENARIO_ID = 'software-delivery' as const;
export const GRAPH_SNAPSHOT_BUILD_SCENARIO_IDS = Object.freeze([
  CONTRACT_TO_DELIVERY_SCENARIO_ID,
  SOFTWARE_DELIVERY_SCENARIO_ID,
] as const);

export type GraphSnapshotBuildScenarioId = (typeof GRAPH_SNAPSHOT_BUILD_SCENARIO_IDS)[number];

export interface GraphSnapshotBuildProfile {
  readonly scenarioId: GraphSnapshotBuildScenarioId;
  readonly sourceBytes: number;
  readonly sourceJsonNodes: number;
  readonly textBytes: number;
}

export interface PublishedGraphBuildSnapshot extends PublishedGraphSnapshot {
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export type PublishedSoftwareDeliverySnapshot = PublishedGraphBuildSnapshot;

export interface BuildAndPublishGraphSnapshotInput {
  readonly scenarioId: GraphSnapshotBuildScenarioId;
  readonly sourceBytes: Buffer;
  readonly store: LocalGraphStore;
  readonly expectedCursor: string | null;
  readonly expectedScenarioInstanceId?: string;
}

export interface BuildAndPublishSoftwareDeliverySnapshotInput {
  readonly sourceBytes: Buffer;
  readonly store: LocalGraphStore;
  readonly expectedCursor: string | null;
  readonly expectedScenarioInstanceId?: string;
}

interface ScopedSource {
  readonly scenarioDefinitionId: string;
  readonly scenarioInstanceId: string;
}

interface SealedBuildProfile extends GraphSnapshotBuildProfile {
  readonly projectorId: string;
  readonly validate: (value: unknown) => ScopedSource;
  readonly project: (value: unknown) => { readonly snapshot: GraphSnapshot };
}

const BUILD_PROFILES: Readonly<Record<GraphSnapshotBuildScenarioId, SealedBuildProfile>> =
  Object.freeze({
    [CONTRACT_TO_DELIVERY_SCENARIO_ID]: Object.freeze({
      scenarioId: CONTRACT_TO_DELIVERY_SCENARIO_ID,
      projectorId: CONTRACT_TO_DELIVERY_PROJECTOR_ID,
      sourceBytes: CONTRACT_TO_DELIVERY_SOURCE_LIMITS.sourceBytes,
      sourceJsonNodes: CONTRACT_TO_DELIVERY_SOURCE_LIMITS.sourceJsonNodes,
      textBytes: CONTRACT_TO_DELIVERY_SOURCE_LIMITS.textBytes,
      validate: (value: unknown): ContractToDeliverySourceSnapshot =>
        validateContractToDeliverySourceSnapshot(value),
      project: projectContractToDeliverySnapshot,
    }),
    [SOFTWARE_DELIVERY_SCENARIO_ID]: Object.freeze({
      scenarioId: SOFTWARE_DELIVERY_SCENARIO_ID,
      projectorId: SOFTWARE_DELIVERY_PROJECTOR_ID,
      sourceBytes: SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes,
      sourceJsonNodes: SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceJsonNodes,
      textBytes: SOFTWARE_DELIVERY_SOURCE_LIMITS.textBytes,
      validate: (value: unknown): SoftwareDeliverySourceSnapshot =>
        validateSoftwareDeliverySourceSnapshot(value),
      project: projectSoftwareDeliverySnapshot,
    }),
  });

function scopeFail(path: string, message: string): never {
  throw new GraphContractError('GRAPH_SCOPE_INVALID', path, message);
}

function isRegisteredScenarioId(value: string): value is GraphSnapshotBuildScenarioId {
  return (GRAPH_SNAPSHOT_BUILD_SCENARIO_IDS as readonly string[]).includes(value);
}

export function graphSnapshotBuildProfile(
  scenarioId: string,
): Readonly<GraphSnapshotBuildProfile> | undefined {
  if (!isRegisteredScenarioId(scenarioId)) return undefined;
  const profile = BUILD_PROFILES[scenarioId];
  return Object.freeze({
    scenarioId: profile.scenarioId,
    sourceBytes: profile.sourceBytes,
    sourceJsonNodes: profile.sourceJsonNodes,
    textBytes: profile.textBytes,
  });
}

function assertScope(
  source: ScopedSource,
  scenarioId: GraphSnapshotBuildScenarioId,
  expectedScenarioInstanceId?: string,
): void {
  if (source.scenarioDefinitionId !== scenarioId) {
    scopeFail('$.scenarioDefinitionId', `must equal the registered scenario ${scenarioId}.`);
  }
  if (
    expectedScenarioInstanceId !== undefined &&
    source.scenarioInstanceId !== expectedScenarioInstanceId
  ) {
    scopeFail('$.scenarioInstanceId', 'does not match the explicitly requested scenario instance.');
  }
}

/**
 * Strictly parses, validates, projects, and compare-and-swap publishes one
 * caller-supplied evidence snapshot through a host-owned sealed dispatch.
 *
 * The dispatch is static code. Scenario Packs cannot provide module paths,
 * projector functions, or alternate byte ceilings.
 */
export async function buildAndPublishGraphSnapshot(
  input: BuildAndPublishGraphSnapshotInput,
): Promise<PublishedGraphBuildSnapshot> {
  if (!isRegisteredScenarioId(input.scenarioId)) {
    scopeFail('$.scenarioId', 'is not registered by the sealed graph snapshot dispatch.');
  }
  const profile = BUILD_PROFILES[input.scenarioId];
  if (input.sourceBytes.length > profile.sourceBytes) {
    throw new GraphContractError(
      'GRAPH_BOUND_EXCEEDED',
      '$',
      `source exceeds ${profile.sourceBytes} bytes.`,
    );
  }

  const parsed = parseStrictGraphJson(input.sourceBytes, {
    maxDepth: 32,
    maxNodes: profile.sourceJsonNodes,
    maxStringLength: profile.textBytes,
  });
  const source = profile.validate(parsed);
  assertScope(source, input.scenarioId, input.expectedScenarioInstanceId);

  const { snapshot } = profile.project(source);
  if (
    snapshot.scenarioInstanceId !== source.scenarioInstanceId ||
    snapshot.projectorVersion !== profile.projectorId
  ) {
    scopeFail(
      '$',
      'does not match the scenario instance or projector emitted by the sealed host dispatch.',
    );
  }
  if (
    input.expectedScenarioInstanceId !== undefined &&
    snapshot.scenarioInstanceId !== input.expectedScenarioInstanceId
  ) {
    scopeFail(
      '$.scenarioInstanceId',
      'does not match the explicitly requested projected scenario instance.',
    );
  }

  const published = await input.store.publishSnapshot(snapshot, {
    expectedCursor: input.expectedCursor,
  });
  return Object.freeze({
    ...published,
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
  });
}

/**
 * Compatibility wrapper retained for existing Software Delivery callers.
 */
export async function buildAndPublishSoftwareDeliverySnapshot(
  input: BuildAndPublishSoftwareDeliverySnapshotInput,
): Promise<PublishedSoftwareDeliverySnapshot> {
  return buildAndPublishGraphSnapshot({
    scenarioId: SOFTWARE_DELIVERY_SCENARIO_ID,
    ...input,
  });
}
