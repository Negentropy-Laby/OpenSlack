import type { AuthorityRef, GraphSnapshot } from './types.js';
import type { SoftwareDeliverySourceSnapshot } from './software-delivery-types.js';
import {
  SOFTWARE_DELIVERY_PROJECTOR_CONTRACT,
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
} from './software-delivery-types.js';

export const CONTRACT_TO_DELIVERY_SOURCE_SCHEMA =
  'openslack.contract_to_delivery_source_snapshot.v1' as const;
export const CONTRACT_TO_DELIVERY_PROJECTOR_ID = 'openslack.contract_to_delivery.v1' as const;
export const CONTRACT_TO_DELIVERY_SCENARIO_ID = 'contract-to-delivery-lite' as const;

const BUSINESS_NODE_TYPES = Object.freeze([
  'business.acceptance',
  'business.contract',
  'business.customer',
  'business.milestone',
  'business.outcome',
  'business.project',
  'informational.acceptance_observation',
  'informational.outcome_observation',
] as const);

const BUSINESS_EDGE_TYPES = Object.freeze([
  'accepted_as',
  'approved_by',
  'closes_work_item',
  'contract_delivered_by',
  'contracts_for',
  'delivers_project',
  'milestone_contains',
  'realizes',
  'scoped_to',
  'substantiated_by',
  'tracks_milestone',
  'transitioned_by',
] as const);

function union(left: readonly string[], right: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([...left, ...right])].sort());
}

export const CONTRACT_TO_DELIVERY_PROJECTOR_CONTRACT = Object.freeze({
  nodeTypes: union(SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.nodeTypes, BUSINESS_NODE_TYPES),
  edgeTypes: union(SOFTWARE_DELIVERY_PROJECTOR_CONTRACT.edgeTypes, BUSINESS_EDGE_TYPES),
});

export const CONTRACT_TO_DELIVERY_SOURCE_LIMITS = Object.freeze({
  observationsPerKind: 500,
  totalObservations: 3_000,
  totalRelations: 12_000,
  sourceBytes: SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes,
  sourceJsonNodes: SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceJsonNodes,
  sourceObjectProperties: SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceObjectProperties,
  sourceArrayItems: SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceArrayItems,
  projectedSnapshotBytes: SOFTWARE_DELIVERY_SOURCE_LIMITS.projectedSnapshotBytes,
  completenessEntries: 50,
  textBytes: SOFTWARE_DELIVERY_SOURCE_LIMITS.textBytes,
});

export type ContractToDeliveryBusinessStatus =
  | 'active'
  | 'planned'
  | 'completed'
  | 'accepted'
  | 'realized'
  | 'pending';

export interface ContractToDeliveryBridgeRef {
  readonly targetType: string;
  readonly authorityRef: AuthorityRef;
}

export interface ContractToDeliveryBusinessEvidence {
  readonly id: string;
  readonly title: string;
  readonly status: ContractToDeliveryBusinessStatus;
  readonly authorityRef: AuthorityRef;
  readonly sourceEventIds: string[];
  readonly evidenceRefs: string[];
}

export type ContractToDeliveryCustomerObservation = ContractToDeliveryBusinessEvidence;

export interface ContractToDeliveryContractObservation extends ContractToDeliveryBusinessEvidence {
  readonly customerId: string;
  readonly deliverable: ContractToDeliveryBridgeRef;
}

export interface ContractToDeliveryProjectObservation extends ContractToDeliveryBusinessEvidence {
  readonly contractId: string;
  readonly workItem: ContractToDeliveryBridgeRef;
}

export interface ContractToDeliveryMilestoneObservation extends ContractToDeliveryBusinessEvidence {
  readonly projectId: string;
  readonly workItem: ContractToDeliveryBridgeRef;
}

export interface ContractToDeliveryAcceptanceObservation extends ContractToDeliveryBusinessEvidence {
  readonly deliverable: ContractToDeliveryBridgeRef;
  readonly humanDecision: ContractToDeliveryBridgeRef;
  readonly acceptedTransition: ContractToDeliveryBridgeRef;
}

export interface ContractToDeliveryOutcomeObservation extends ContractToDeliveryBusinessEvidence {
  readonly acceptanceId: string;
  readonly workItem: ContractToDeliveryBridgeRef;
  readonly softwareOutcome: ContractToDeliveryBridgeRef;
}

export interface ContractToDeliveryObservedBatch<T> {
  readonly status: 'observed';
  readonly batchVersion: string;
  readonly observedAt: string;
  readonly items: T[];
  readonly warningCodes: string[];
}

export interface ContractToDeliveryIncompleteBatch<T> {
  readonly status: 'incomplete';
  readonly batchVersion: string;
  readonly observedAt: string;
  readonly items: T[];
  readonly warningCodes: string[];
}

export interface ContractToDeliveryMissingBatch {
  readonly status: 'missing';
  readonly items: [];
  readonly reasonCode: string;
}

export type ContractToDeliverySourceBatch<T> =
  | ContractToDeliveryObservedBatch<T>
  | ContractToDeliveryIncompleteBatch<T>
  | ContractToDeliveryMissingBatch;

export interface ContractToDeliveryBusinessSources {
  readonly customers: ContractToDeliverySourceBatch<ContractToDeliveryCustomerObservation>;
  readonly contracts: ContractToDeliverySourceBatch<ContractToDeliveryContractObservation>;
  readonly projects: ContractToDeliverySourceBatch<ContractToDeliveryProjectObservation>;
  readonly milestones: ContractToDeliverySourceBatch<ContractToDeliveryMilestoneObservation>;
  readonly acceptances: ContractToDeliverySourceBatch<ContractToDeliveryAcceptanceObservation>;
  readonly outcomes: ContractToDeliverySourceBatch<ContractToDeliveryOutcomeObservation>;
}

export interface ContractToDeliverySourceSnapshot {
  readonly schema: typeof CONTRACT_TO_DELIVERY_SOURCE_SCHEMA;
  readonly scenarioDefinitionId: typeof CONTRACT_TO_DELIVERY_SCENARIO_ID;
  readonly scenarioInstanceId: string;
  readonly cursor: string;
  readonly generatedAt: string;
  readonly projectorVersion: typeof CONTRACT_TO_DELIVERY_PROJECTOR_ID;
  readonly softwareDelivery: SoftwareDeliverySourceSnapshot;
  readonly business: ContractToDeliveryBusinessSources;
}

export interface ContractToDeliveryProjectionResult {
  readonly projectorId: typeof CONTRACT_TO_DELIVERY_PROJECTOR_ID;
  readonly snapshot: GraphSnapshot;
}
