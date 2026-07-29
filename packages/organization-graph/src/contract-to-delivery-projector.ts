import { canonicalJson } from './canonical.js';
import {
  CONTRACT_TO_DELIVERY_PROJECTOR_ID,
  CONTRACT_TO_DELIVERY_SOURCE_LIMITS,
  type ContractToDeliveryBridgeRef,
  type ContractToDeliveryBusinessEvidence,
  type ContractToDeliveryBusinessSources,
  type ContractToDeliveryProjectionResult,
  type ContractToDeliverySourceBatch,
  type ContractToDeliverySourceSnapshot,
} from './contract-to-delivery-types.js';
import { validateContractToDeliverySourceSnapshot } from './contract-to-delivery-validation.js';
import { GraphContractError } from './errors.js';
import { deriveGraphEdgeId, deriveGraphNodeId } from './identity.js';
import { sealGraphSnapshot } from './integrity.js';
import { projectSoftwareDeliverySnapshot } from './software-delivery-projector.js';
import type { AuthorityRef, GraphCompleteness, GraphEdge, GraphNode } from './types.js';

type BusinessSourceName = keyof ContractToDeliveryBusinessSources;

const BUSINESS_SOURCE_NAMES = Object.freeze([
  'customers',
  'contracts',
  'projects',
  'milestones',
  'acceptances',
  'outcomes',
] as const satisfies readonly BusinessSourceName[]);
const MAX_COMPLETENESS_ENTRIES = CONTRACT_TO_DELIVERY_SOURCE_LIMITS.completenessEntries;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function boundedCompleteness(values: readonly string[], suffix: string): string[] {
  const canonical = uniqueSorted(values);
  if (canonical.length <= MAX_COMPLETENESS_ENTRIES) return canonical;
  return [
    ...canonical.slice(0, MAX_COMPLETENESS_ENTRIES - 1),
    `contract-to-delivery.${suffix}.truncated`,
  ].sort(compare);
}

function authorityEqual(left: AuthorityRef, right: AuthorityRef): boolean {
  return (
    left.provider === right.provider &&
    left.objectType === right.objectType &&
    left.objectId === right.objectId &&
    left.version === right.version &&
    left.observedAt === right.observedAt
  );
}

function nodeFrom(input: {
  source: ContractToDeliverySourceSnapshot;
  observation: ContractToDeliveryBusinessEvidence;
  type: string;
  status?: string;
  properties: Record<string, unknown>;
}): GraphNode {
  const node: GraphNode = {
    id: '',
    type: input.type,
    scenarioDefinitionId: input.source.scenarioDefinitionId,
    scenarioInstanceId: input.source.scenarioInstanceId,
    title: input.observation.title,
    status: input.status ?? input.observation.status,
    authorityRef: input.observation.authorityRef,
    owners: [],
    properties: input.properties,
    sourceEventIds: uniqueSorted(input.observation.sourceEventIds),
    evidenceRefs: uniqueSorted(input.observation.evidenceRefs),
    projectorVersion: CONTRACT_TO_DELIVERY_PROJECTOR_ID,
    validFrom: input.observation.authorityRef.observedAt,
  };
  node.id = deriveGraphNodeId({
    scenarioInstanceId: node.scenarioInstanceId,
    type: node.type,
    authorityRef: node.authorityRef,
  });
  return node;
}

function edgeFrom(input: {
  source: ContractToDeliverySourceSnapshot;
  observation: ContractToDeliveryBusinessEvidence;
  type: string;
  from: string;
  to: string;
}): GraphEdge {
  const edge: GraphEdge = {
    id: '',
    type: input.type,
    from: input.from,
    to: input.to,
    scenarioInstanceId: input.source.scenarioInstanceId,
    authorityRef: input.observation.authorityRef,
    sourceEventIds: uniqueSorted(input.observation.sourceEventIds),
    evidenceRefs: uniqueSorted(input.observation.evidenceRefs),
    projectorVersion: CONTRACT_TO_DELIVERY_PROJECTOR_ID,
    validFrom: input.observation.authorityRef.observedAt,
  };
  edge.id = deriveGraphEdgeId({
    scenarioInstanceId: edge.scenarioInstanceId,
    type: edge.type,
    from: edge.from,
    to: edge.to,
    authorityRef: edge.authorityRef,
  });
  return edge;
}

function batchItems<T>(batch: ContractToDeliverySourceBatch<T>): readonly T[] {
  return batch.items;
}

class CompositeBuilder {
  readonly nodes: Map<string, GraphNode>;
  readonly edges: Map<string, GraphEdge>;
  readonly businessNodes = new Map<string, string>();
  readonly missing = new Set<string>();
  readonly warnings = new Set<string>();
  readonly promotedAcceptances = new Set<string>();

  constructor(
    readonly source: ContractToDeliverySourceSnapshot,
    softwareNodes: readonly GraphNode[],
    softwareEdges: readonly GraphEdge[],
    readonly softwareCompleteness: GraphCompleteness,
  ) {
    this.nodes = new Map(softwareNodes.map((node) => [node.id, node]));
    this.edges = new Map(softwareEdges.map((edge) => [edge.id, edge]));
    for (const node of softwareNodes) {
      if (
        node.scenarioDefinitionId !== source.scenarioDefinitionId ||
        node.scenarioInstanceId !== source.scenarioInstanceId
      ) {
        throw new GraphContractError(
          'GRAPH_SCOPE_INVALID',
          '$.softwareDelivery',
          'projected Software Delivery nodes escaped the composite scenario scope.',
        );
      }
    }
    for (const edge of softwareEdges) {
      if (edge.scenarioInstanceId !== source.scenarioInstanceId) {
        throw new GraphContractError(
          'GRAPH_SCOPE_INVALID',
          '$.softwareDelivery',
          'projected Software Delivery edges escaped the composite scenario instance.',
        );
      }
    }
  }

  addNode(kind: string, observation: ContractToDeliveryBusinessEvidence, node: GraphNode): void {
    if (this.nodes.has(node.id)) {
      throw new GraphContractError(
        'GRAPH_REFERENCE_INVALID',
        '$.business',
        `composite projection produced duplicate graph identity ${node.id}.`,
      );
    }
    this.nodes.set(node.id, node);
    this.businessNodes.set(`${kind}:${observation.id}`, node.id);
  }

  findBusiness(kind: string, id: string): string | undefined {
    return this.businessNodes.get(`${kind}:${id}`);
  }

  findBridge(bridge: ContractToDeliveryBridgeRef, code: string): GraphNode | undefined {
    const nodeId = deriveGraphNodeId({
      scenarioInstanceId: this.source.scenarioInstanceId,
      type: bridge.targetType,
      authorityRef: bridge.authorityRef,
    });
    const node = this.nodes.get(nodeId);
    if (
      node === undefined ||
      node.type !== bridge.targetType ||
      !authorityEqual(node.authorityRef, bridge.authorityRef)
    ) {
      this.incomplete(`bridge.${code}`);
      this.warn(`bridge.${code}.unresolved`);
      return undefined;
    }
    return node;
  }

  addEdge(
    type: string,
    from: string | undefined,
    to: string | undefined,
    observation: ContractToDeliveryBusinessEvidence,
    code: string,
  ): void {
    if (from === undefined || to === undefined) {
      this.incomplete(`reference.${code}`);
      this.warn(`reference.${code}.unresolved`);
      return;
    }
    const edge = edgeFrom({ source: this.source, observation, type, from, to });
    if (this.edges.has(edge.id)) {
      throw new GraphContractError(
        'GRAPH_REFERENCE_INVALID',
        '$.business',
        `composite projection produced duplicate edge identity ${edge.id}.`,
      );
    }
    this.edges.set(edge.id, edge);
  }

  hasEdge(type: string, from: string, to: string): boolean {
    return [...this.edges.values()].some(
      (edge) => edge.type === type && edge.from === from && edge.to === to,
    );
  }

  warn(code: string): void {
    this.warnings.add(`contract-to-delivery.${code}`);
  }

  incomplete(code: string): void {
    this.missing.add(`contract-to-delivery.${code}`);
  }

  completeness(): GraphCompleteness {
    const requested = [
      ...this.softwareCompleteness.sourcesRequested,
      ...BUSINESS_SOURCE_NAMES.map((name) => `demo_fixture.${name}`),
    ];
    const observed = [...this.softwareCompleteness.sourcesObserved];
    const missing = [...this.softwareCompleteness.missingSources, ...this.missing];
    const warnings = [...this.softwareCompleteness.warnings, ...this.warnings];
    for (const name of BUSINESS_SOURCE_NAMES) {
      const batch = this.source.business[name];
      const token = `demo_fixture.${name}`;
      if (batch.status === 'observed') observed.push(token);
      else missing.push(token);
      if (batch.status === 'missing') warnings.push(`${token}.${batch.reasonCode}`);
      else warnings.push(...batch.warningCodes.map((code) => `${token}.${code}`));
    }
    return {
      sourcesRequested: boundedCompleteness(requested, 'sources-requested'),
      sourcesObserved: boundedCompleteness(observed, 'sources-observed'),
      missingSources: boundedCompleteness(missing, 'missing-sources'),
      warnings: boundedCompleteness(warnings, 'warnings'),
    };
  }
}

function addBaseBusinessNodes(builder: CompositeBuilder): void {
  for (const observation of batchItems(builder.source.business.customers)) {
    builder.addNode(
      'customer',
      observation,
      nodeFrom({
        source: builder.source,
        observation,
        type: 'business.customer',
        properties: { observationId: observation.id },
      }),
    );
  }
  for (const observation of batchItems(builder.source.business.contracts)) {
    builder.addNode(
      'contract',
      observation,
      nodeFrom({
        source: builder.source,
        observation,
        type: 'business.contract',
        properties: {
          customerObservationId: observation.customerId,
          observationId: observation.id,
        },
      }),
    );
  }
  for (const observation of batchItems(builder.source.business.projects)) {
    builder.addNode(
      'project',
      observation,
      nodeFrom({
        source: builder.source,
        observation,
        type: 'business.project',
        properties: {
          contractObservationId: observation.contractId,
          observationId: observation.id,
        },
      }),
    );
  }
  for (const observation of batchItems(builder.source.business.milestones)) {
    builder.addNode(
      'milestone',
      observation,
      nodeFrom({
        source: builder.source,
        observation,
        type: 'business.milestone',
        properties: {
          observationId: observation.id,
          projectObservationId: observation.projectId,
        },
      }),
    );
  }
}

function addBaseBusinessEdges(builder: CompositeBuilder): void {
  for (const contract of batchItems(builder.source.business.contracts)) {
    const contractId = builder.findBusiness('contract', contract.id);
    builder.addEdge(
      'contracts_for',
      builder.findBusiness('customer', contract.customerId),
      contractId,
      contract,
      `contract.customer.${contract.id}`,
    );
    const deliverable = builder.findBridge(
      contract.deliverable,
      `contract.deliverable.${contract.id}`,
    );
    builder.addEdge(
      'contract_delivered_by',
      contractId,
      deliverable?.id,
      contract,
      `contract.deliverable.${contract.id}`,
    );
  }
  for (const project of batchItems(builder.source.business.projects)) {
    const projectId = builder.findBusiness('project', project.id);
    builder.addEdge(
      'delivers_project',
      builder.findBusiness('contract', project.contractId),
      projectId,
      project,
      `project.contract.${project.id}`,
    );
    const workItem = builder.findBridge(project.workItem, `project.workItem.${project.id}`);
    builder.addEdge(
      'scoped_to',
      projectId,
      workItem?.id,
      project,
      `project.workItem.${project.id}`,
    );
  }
  for (const milestone of batchItems(builder.source.business.milestones)) {
    const milestoneId = builder.findBusiness('milestone', milestone.id);
    builder.addEdge(
      'tracks_milestone',
      builder.findBusiness('project', milestone.projectId),
      milestoneId,
      milestone,
      `milestone.project.${milestone.id}`,
    );
    const workItem = builder.findBridge(milestone.workItem, `milestone.workItem.${milestone.id}`);
    builder.addEdge(
      'milestone_contains',
      milestoneId,
      workItem?.id,
      milestone,
      `milestone.workItem.${milestone.id}`,
    );
  }
}

function deliverableIsCurrent(node: GraphNode): boolean {
  return (
    node.type === 'reviewable_deliverable' &&
    node.status === 'merged' &&
    node.properties.currentHeadBound === true &&
    node.properties.draft === false
  );
}

function decisionIsCurrentApproval(node: GraphNode): boolean {
  return (
    node.type === 'human_decision' &&
    node.status === 'APPROVED' &&
    node.properties.actorKind === 'human' &&
    node.properties.currentHeadBound === true &&
    node.properties.independentReviewer === true
  );
}

function transitionIsCurrent(node: GraphNode): boolean {
  return (
    node.type === 'accepted_transition' &&
    node.status === 'accepted' &&
    node.properties.currentHeadBound === true
  );
}

function addAcceptances(builder: CompositeBuilder): void {
  for (const acceptance of batchItems(builder.source.business.acceptances)) {
    const deliverable = builder.findBridge(
      acceptance.deliverable,
      `acceptance.deliverable.${acceptance.id}`,
    );
    const decision = builder.findBridge(
      acceptance.humanDecision,
      `acceptance.humanDecision.${acceptance.id}`,
    );
    const transition = builder.findBridge(
      acceptance.acceptedTransition,
      `acceptance.acceptedTransition.${acceptance.id}`,
    );
    const promoted =
      deliverable !== undefined &&
      decision !== undefined &&
      transition !== undefined &&
      deliverableIsCurrent(deliverable) &&
      decisionIsCurrentApproval(decision) &&
      transitionIsCurrent(transition) &&
      builder.hasEdge('reviewed_by', deliverable.id, decision.id) &&
      builder.hasEdge('accepted_by', deliverable.id, transition.id);
    const node = nodeFrom({
      source: builder.source,
      observation: acceptance,
      type: promoted ? 'business.acceptance' : 'informational.acceptance_observation',
      status: promoted ? 'accepted' : 'pending',
      properties: {
        observationId: acceptance.id,
        promoted,
        ...(deliverable === undefined ? {} : { deliverableNodeId: deliverable.id }),
        ...(decision === undefined ? {} : { humanDecisionNodeId: decision.id }),
        ...(transition === undefined ? {} : { acceptedTransitionNodeId: transition.id }),
      },
    });
    builder.addNode('acceptance', acceptance, node);
    if (!promoted) {
      builder.incomplete(`acceptance.promotion.${acceptance.id}`);
      builder.warn(`acceptance.informational.${acceptance.id}`);
      continue;
    }
    builder.promotedAcceptances.add(acceptance.id);
    builder.addEdge(
      'accepted_as',
      deliverable.id,
      node.id,
      acceptance,
      `acceptance.deliverable.${acceptance.id}`,
    );
    builder.addEdge(
      'approved_by',
      node.id,
      decision.id,
      acceptance,
      `acceptance.humanDecision.${acceptance.id}`,
    );
    builder.addEdge(
      'transitioned_by',
      node.id,
      transition.id,
      acceptance,
      `acceptance.acceptedTransition.${acceptance.id}`,
    );
  }
}

function workItemIsClosed(node: GraphNode): boolean {
  return (
    node.type === 'core.work_item' &&
    node.status === 'closed' &&
    node.properties.closureComplete === true &&
    node.properties.observationKind === 'live'
  );
}

function addOutcomes(builder: CompositeBuilder): void {
  for (const outcome of batchItems(builder.source.business.outcomes)) {
    const acceptanceId = builder.findBusiness('acceptance', outcome.acceptanceId);
    const workItem = builder.findBridge(outcome.workItem, `outcome.workItem.${outcome.id}`);
    const softwareOutcome = builder.findBridge(
      outcome.softwareOutcome,
      `outcome.softwareOutcome.${outcome.id}`,
    );
    const promoted =
      acceptanceId !== undefined &&
      builder.promotedAcceptances.has(outcome.acceptanceId) &&
      workItem !== undefined &&
      softwareOutcome !== undefined &&
      workItemIsClosed(workItem) &&
      softwareOutcome.type === 'outcome' &&
      builder.hasEdge('closes_as', workItem.id, softwareOutcome.id);
    const node = nodeFrom({
      source: builder.source,
      observation: outcome,
      type: promoted ? 'business.outcome' : 'informational.outcome_observation',
      status: promoted ? 'realized' : 'pending',
      properties: {
        acceptanceObservationId: outcome.acceptanceId,
        observationId: outcome.id,
        promoted,
        ...(workItem === undefined ? {} : { workItemNodeId: workItem.id }),
        ...(softwareOutcome === undefined ? {} : { softwareOutcomeNodeId: softwareOutcome.id }),
      },
    });
    builder.addNode('outcome', outcome, node);
    if (!promoted) {
      builder.incomplete(`outcome.promotion.${outcome.id}`);
      builder.warn(`outcome.informational.${outcome.id}`);
      continue;
    }
    builder.addEdge('realizes', acceptanceId, node.id, outcome, `outcome.acceptance.${outcome.id}`);
    builder.addEdge(
      'closes_work_item',
      node.id,
      workItem.id,
      outcome,
      `outcome.workItem.${outcome.id}`,
    );
    builder.addEdge(
      'substantiated_by',
      node.id,
      softwareOutcome.id,
      outcome,
      `outcome.softwareOutcome.${outcome.id}`,
    );
  }
}

export function projectContractToDeliverySnapshot(
  value: unknown,
): ContractToDeliveryProjectionResult {
  const source = validateContractToDeliverySourceSnapshot(value);
  const softwareProjection = projectSoftwareDeliverySnapshot(source.softwareDelivery);
  const builder = new CompositeBuilder(
    source,
    softwareProjection.snapshot.nodes,
    softwareProjection.snapshot.edges,
    softwareProjection.snapshot.completeness,
  );

  addBaseBusinessNodes(builder);
  addBaseBusinessEdges(builder);
  addAcceptances(builder);
  addOutcomes(builder);

  const snapshot = sealGraphSnapshot({
    schema: 'openslack.graph_snapshot.v1',
    cursor: source.cursor,
    scenarioInstanceId: source.scenarioInstanceId,
    generatedAt: source.generatedAt,
    projectorVersion: CONTRACT_TO_DELIVERY_PROJECTOR_ID,
    nodes: [...builder.nodes.values()],
    edges: [...builder.edges.values()],
    completeness: builder.completeness(),
  });
  const projectedBytes = Buffer.byteLength(canonicalJson(snapshot), 'utf8') + 1;
  if (projectedBytes > CONTRACT_TO_DELIVERY_SOURCE_LIMITS.projectedSnapshotBytes) {
    throw new GraphContractError(
      'GRAPH_BOUND_EXCEEDED',
      '$.business',
      `projected snapshot contains ${projectedBytes} bytes; maximum is ${CONTRACT_TO_DELIVERY_SOURCE_LIMITS.projectedSnapshotBytes}.`,
    );
  }
  return Object.freeze({
    projectorId: CONTRACT_TO_DELIVERY_PROJECTOR_ID,
    snapshot,
  });
}
