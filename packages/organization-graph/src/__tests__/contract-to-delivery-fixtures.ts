import {
  CONTRACT_TO_DELIVERY_PROJECTOR_ID,
  CONTRACT_TO_DELIVERY_SCENARIO_ID,
  CONTRACT_TO_DELIVERY_SOURCE_SCHEMA,
  projectSoftwareDeliverySnapshot,
  type AuthorityRef,
  type ContractToDeliveryBridgeRef,
  type ContractToDeliveryBusinessEvidence,
  type ContractToDeliveryObservedBatch,
  type ContractToDeliverySourceSnapshot,
  type GraphNode,
} from '../index.js';
import { softwareDeliverySource } from './software-delivery-fixtures.js';

const observedAt = '2026-07-27T01:45:00.000Z';
const generatedAt = '2026-07-27T02:00:00.000Z';

function businessEvidence(
  id: string,
  objectType: string,
  title: string,
  status: ContractToDeliveryBusinessEvidence['status'],
): ContractToDeliveryBusinessEvidence {
  return {
    id,
    title,
    status,
    authorityRef: {
      provider: 'demo_fixture',
      objectType,
      objectId: id,
      version: `fixture-${id}-v1`,
      observedAt,
    },
    sourceEventIds: [`event:${id}`],
    evidenceRefs: [`fixture:${id}`],
  };
}

function observed<T>(name: string, items: T[]): ContractToDeliveryObservedBatch<T> {
  return {
    status: 'observed',
    batchVersion: `fixture-${name}-v1`,
    observedAt,
    items,
    warningCodes: [],
  };
}

function bridge(node: GraphNode): ContractToDeliveryBridgeRef {
  return {
    targetType: node.type,
    authorityRef: { ...node.authorityRef },
  };
}

function requiredNode(nodes: readonly GraphNode[], type: string, objectId: string): GraphNode {
  const node = nodes.find(
    (candidate) => candidate.type === type && candidate.authorityRef.objectId === objectId,
  );
  if (node === undefined) throw new Error(`Missing fixture node ${type}:${objectId}.`);
  return node;
}

export function contractToDeliverySource(): ContractToDeliverySourceSnapshot {
  const softwareDelivery = softwareDeliverySource();
  softwareDelivery.scenarioDefinitionId = CONTRACT_TO_DELIVERY_SCENARIO_ID;
  softwareDelivery.scenarioInstanceId = 'scenario-contract-delivery-001';
  softwareDelivery.cursor = 'contract-source-cursor-001';
  softwareDelivery.generatedAt = generatedAt;
  const software = projectSoftwareDeliverySnapshot(softwareDelivery).snapshot;

  const workItem = requiredNode(software.nodes, 'core.work_item', 'issue-10');
  const deliverable = requiredNode(software.nodes, 'reviewable_deliverable', 'pr-20');
  const humanDecision = requiredNode(software.nodes, 'human_decision', 'review-current');
  const acceptedTransition = requiredNode(software.nodes, 'accepted_transition', 'merge-20');
  const softwareOutcome = requiredNode(software.nodes, 'outcome', 'issue-10');

  return {
    schema: CONTRACT_TO_DELIVERY_SOURCE_SCHEMA,
    scenarioDefinitionId: CONTRACT_TO_DELIVERY_SCENARIO_ID,
    scenarioInstanceId: softwareDelivery.scenarioInstanceId,
    cursor: softwareDelivery.cursor,
    generatedAt,
    projectorVersion: CONTRACT_TO_DELIVERY_PROJECTOR_ID,
    softwareDelivery,
    business: {
      customers: observed('customers', [
        businessEvidence('customer-acme', 'customer', 'Acme Corporation', 'active'),
      ]),
      contracts: observed('contracts', [
        {
          ...businessEvidence(
            'contract-acme-delivery',
            'contract',
            'Acme governed delivery contract',
            'active',
          ),
          customerId: 'customer-acme',
          deliverable: bridge(deliverable),
        },
      ]),
      projects: observed('projects', [
        {
          ...businessEvidence(
            'project-governed-delivery',
            'project',
            'Governed delivery project',
            'active',
          ),
          contractId: 'contract-acme-delivery',
          workItem: bridge(workItem),
        },
      ]),
      milestones: observed('milestones', [
        {
          ...businessEvidence(
            'milestone-accepted-change',
            'milestone',
            'Accepted change milestone',
            'completed',
          ),
          projectId: 'project-governed-delivery',
          workItem: bridge(workItem),
        },
      ]),
      acceptances: observed('acceptances', [
        {
          ...businessEvidence(
            'acceptance-current-head',
            'acceptance',
            'Current-head human acceptance',
            'accepted',
          ),
          deliverable: bridge(deliverable),
          humanDecision: bridge(humanDecision),
          acceptedTransition: bridge(acceptedTransition),
        },
      ]),
      outcomes: observed('outcomes', [
        {
          ...businessEvidence(
            'outcome-contract-realized',
            'outcome',
            'Contract outcome realized',
            'realized',
          ),
          acceptanceId: 'acceptance-current-head',
          workItem: bridge(workItem),
          softwareOutcome: bridge(softwareOutcome),
        },
      ]),
    },
  };
}

export function authorityIdentity(ref: AuthorityRef): string {
  return `${ref.provider}:${ref.objectType}:${ref.objectId}:${ref.version}:${ref.observedAt}`;
}
