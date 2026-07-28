import { GraphContractError } from './errors.js';
import {
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
  type SoftwareDeliverySourceSnapshot,
} from './software-delivery-types.js';
import { projectSoftwareDeliverySnapshot } from './software-delivery-projector.js';
import { validateSoftwareDeliverySourceSnapshot } from './software-delivery-validation.js';
import { parseStrictGraphJson } from './strict-json.js';
import type { LocalGraphStore, PublishedGraphSnapshot } from './store.js';

export const SOFTWARE_DELIVERY_SCENARIO_ID = 'software-delivery';

export interface PublishedSoftwareDeliverySnapshot extends PublishedGraphSnapshot {
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface BuildAndPublishSoftwareDeliverySnapshotInput {
  readonly sourceBytes: Buffer;
  readonly store: LocalGraphStore;
  readonly expectedCursor: string | null;
  readonly expectedScenarioInstanceId?: string;
}

function scopeFail(path: string, message: string): never {
  throw new GraphContractError('GRAPH_SCOPE_INVALID', path, message);
}

function assertSoftwareDeliveryScope(
  source: SoftwareDeliverySourceSnapshot,
  expectedScenarioInstanceId?: string,
): void {
  if (source.scenarioDefinitionId !== SOFTWARE_DELIVERY_SCENARIO_ID) {
    scopeFail(
      '$.scenarioDefinitionId',
      `must equal the registered scenario ${SOFTWARE_DELIVERY_SCENARIO_ID}.`,
    );
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
 * caller-supplied Software Delivery evidence snapshot.
 *
 * This service never assembles live evidence and never performs implicit
 * refreshes. Callers must supply the complete bounded source bytes and the
 * cursor they expect to replace.
 */
export async function buildAndPublishSoftwareDeliverySnapshot(
  input: BuildAndPublishSoftwareDeliverySnapshotInput,
): Promise<PublishedSoftwareDeliverySnapshot> {
  if (input.sourceBytes.length > SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes) {
    throw new GraphContractError(
      'GRAPH_BOUND_EXCEEDED',
      '$',
      `source exceeds ${SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes} bytes.`,
    );
  }

  const parsed = parseStrictGraphJson(input.sourceBytes, {
    maxDepth: 32,
    maxNodes: SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceJsonNodes,
    maxStringLength: SOFTWARE_DELIVERY_SOURCE_LIMITS.textBytes,
  });
  const source = validateSoftwareDeliverySourceSnapshot(parsed);
  assertSoftwareDeliveryScope(source, input.expectedScenarioInstanceId);

  const { snapshot } = projectSoftwareDeliverySnapshot(source);
  if (snapshot.scenarioInstanceId !== source.scenarioInstanceId) {
    scopeFail(
      '$.scenarioInstanceId',
      'does not match the scenario instance emitted by the registered projector.',
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
