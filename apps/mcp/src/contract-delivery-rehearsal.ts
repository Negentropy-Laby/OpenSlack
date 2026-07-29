import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createEvent, type BoundCollaborationEventAppender } from '@openslack/collaboration';
import {
  buildAndPublishGraphSnapshot,
  canonicalJson,
  CONTRACT_TO_DELIVERY_SCENARIO_ID,
  createContractToDeliveryDemoSource,
  LocalGraphStore,
  validateContractToDeliverySourceSnapshot,
  type ContractToDeliverySourceSnapshot,
  type PublishedGraphBuildSnapshot,
  type SoftwareDeliveryWorkflowRunObservation,
} from '@openslack/organization-graph';
import {
  LocalGovernedPlanStore,
  validateGovernedPlanRecord,
  type GovernedActionExecutionContext,
  type GovernedJsonValue,
  type GovernedPlanRecord,
} from '@openslack/operator';
import {
  LocalScenarioInstanceStore,
  transitionScenarioInstance,
  type LoadedScenarioDefinition,
  type ScenarioInstance,
} from '@openslack/scenario-runtime';
import {
  assertContractDeliveryLiteWorkflowPlan,
  CONTRACT_DELIVERY_LITE_EXECUTOR_ID,
  CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
  createContractDeliveryLiteWorkflowReceipt,
  validateContractDeliveryLiteWorkflowReceipt,
  type ContractDeliveryLiteWorkflowReceipt,
  type WorkflowStartPlan,
} from '@openslack/workflows';
import { OpenSlackMcpToolError } from './errors.js';

export const CONTRACT_DELIVERY_REHEARSAL_BUILD_SOURCE_PATH = fileURLToPath(import.meta.url);

export interface ExecuteContractDeliveryLiteWorkflowInput {
  readonly workflowPlan: WorkflowStartPlan;
  readonly context: GovernedActionExecutionContext;
  readonly definition: LoadedScenarioDefinition;
  readonly scenarioInstanceRoot: string;
  readonly eventAppender: BoundCollaborationEventAppender;
  readonly provider: 'cli' | 'slack' | 'github' | 'webhook';
}

export interface ContractDeliveryLiteWorkflowExecution {
  readonly receipt: ContractDeliveryLiteWorkflowReceipt;
  readonly scenarioInstance: ScenarioInstance;
  readonly scenarioRevision: string;
  readonly collaborationEventId: string;
  readonly evidenceRefs: readonly string[];
}

export interface AssembleContractDeliveryLiteRehearsalInput {
  readonly governedPlanRoot: string;
  readonly scenarioInstanceRoot: string;
  readonly workflowPlanId: string;
  readonly scenarioInstanceId: string;
  readonly scenarioCorrelationId: string;
}

export interface PublishContractDeliveryLiteRehearsalInput {
  readonly workspaceRoot: string;
  readonly source: ContractToDeliverySourceSnapshot;
  readonly expectedCursor: string | null;
}

type MutableContractSource = {
  scenarioInstanceId: string;
  cursor: string;
  generatedAt: string;
  softwareDelivery: {
    scenarioInstanceId: string;
    cursor: string;
    generatedAt: string;
    sources: {
      workflowRuns: {
        status: string;
        batchVersion?: string;
        observedAt?: string;
        items: SoftwareDeliveryWorkflowRunObservation[];
        warningCodes?: string[];
      };
    };
  };
};

function blocked(code: string, message: string): never {
  throw new OpenSlackMcpToolError(code, message, 'blocked');
}

function workflowPlanFromActionInput(value: GovernedJsonValue): WorkflowStartPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return blocked('GOVERNED_WORKFLOW_PLAN_INVALID', 'The persisted Workflow action is invalid.');
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'workflowPlan') {
    return blocked(
      'GOVERNED_WORKFLOW_PLAN_INVALID',
      'The persisted Workflow action has an invalid shape.',
    );
  }
  return (value as unknown as { readonly workflowPlan: WorkflowStartPlan }).workflowPlan;
}

function monotonicTimestamp(after: string): string {
  const now = Date.now();
  const prior = Date.parse(after);
  return new Date(Math.max(now, prior + 1)).toISOString();
}

export async function executeContractDeliveryLiteWorkflow(
  input: ExecuteContractDeliveryLiteWorkflowInput,
): Promise<ContractDeliveryLiteWorkflowExecution> {
  const workflowInput = assertContractDeliveryLiteWorkflowPlan(input.workflowPlan);
  if (
    input.context.actorId !== input.workflowPlan.actorId ||
    input.context.workspaceId !== input.workflowPlan.workspaceId ||
    input.context.correlationId !== input.workflowPlan.correlationId ||
    input.definition.manifest.id !== CONTRACT_TO_DELIVERY_SCENARIO_ID
  ) {
    return blocked(
      'GOVERNED_WORKFLOW_BINDING_CHANGED',
      'The reviewed Workflow authority or Scenario definition binding changed.',
    );
  }
  const store = new LocalScenarioInstanceStore(
    input.scenarioInstanceRoot,
    workflowInput.scenarioCorrelationId,
  );
  const current = await store.readWithRevision(workflowInput.scenarioInstanceId);
  if (
    !current ||
    current.instance.state !== 'active' ||
    current.instance.definitionId !== CONTRACT_TO_DELIVERY_SCENARIO_ID ||
    current.instance.definitionHash !== input.definition.definitionHash ||
    current.instance.correlationId !== workflowInput.scenarioCorrelationId
  ) {
    return blocked(
      'GOVERNED_WORKFLOW_SCENARIO_NOT_ACTIVE',
      'The bound Contract-to-Delivery Scenario instance is not active or changed.',
    );
  }

  const receipt = createContractDeliveryLiteWorkflowReceipt(input.workflowPlan);
  const event = createEvent({
    type: 'workflow.started',
    actor: { id: input.context.actorId, kind: 'agent', provider: input.provider },
    object: { kind: 'workflow', id: receipt.workflowRunId },
    source: { kind: 'operator', ref: 'contract-delivery-local-rehearsal' },
    summary: 'Started the reviewed credential-free Contract-to-Delivery local rehearsal.',
    owner: { id: input.context.actorId, kind: 'agent' },
    risk: 'low',
    severity: 'info',
    visibility: 'workspace',
    correlationId: input.context.correlationId,
    redacted: true,
    containsSensitiveData: false,
    metadata: {
      evidenceLevel: receipt.evidenceLevel,
      fixtureId: receipt.fixtureId,
      scenarioInstanceId: receipt.scenarioInstanceId,
      notificationIntent: receipt.origins.notificationIntent,
      notificationDelivery: receipt.origins.notificationDelivery,
      liveGitHub: receipt.origins.liveGitHub,
      liveCapstone: receipt.origins.liveCapstone,
      qoderDesktop: receipt.origins.qoderDesktop,
    },
  });
  input.eventAppender.append(event);

  const evidenceRefs = Object.freeze([
    `collaboration-event:${event.id}`,
    `governed-plan:${input.context.planId}`,
    `workflow-plan:sha256:${input.workflowPlan.planHash}`,
  ]);
  const completed = await store.write(
    transitionScenarioInstance(current.instance, {
      state: 'completed',
      updatedAt: monotonicTimestamp(current.instance.updatedAt),
      workflowRunIds: Object.freeze(
        [...new Set([...current.instance.workflowRunIds, receipt.workflowRunId])].sort(),
      ),
      evidenceRefs,
    }),
    { expectedRevision: current.revision },
  );
  const readback = await store.readWithRevision(receipt.scenarioInstanceId);
  if (
    !readback ||
    readback.revision !== completed.revision ||
    readback.instance.state !== 'completed' ||
    !readback.instance.workflowRunIds.includes(receipt.workflowRunId) ||
    !evidenceRefs.every((reference) => readback.instance.evidenceRefs.includes(reference))
  ) {
    throw new OpenSlackMcpToolError(
      'GOVERNED_WORKFLOW_READBACK_UNVERIFIED',
      'The Contract-to-Delivery workflow durable readback could not be verified.',
    );
  }
  return Object.freeze({
    receipt,
    scenarioInstance: readback.instance,
    scenarioRevision: readback.revision,
    collaborationEventId: event.id,
    evidenceRefs,
  });
}

function completedWorkflowRecord(value: GovernedPlanRecord): {
  readonly record: GovernedPlanRecord;
  readonly workflowPlan: WorkflowStartPlan;
  readonly receipt: ContractDeliveryLiteWorkflowReceipt;
  readonly evidenceRefs: readonly string[];
} {
  const record = validateGovernedPlanRecord(value);
  if (
    record.state !== 'succeeded' ||
    record.canonicalPlan.kind !== 'workflow.start' ||
    record.canonicalPlan.actions.length !== 1 ||
    record.canonicalPlan.actions[0]?.actionId !== CONTRACT_DELIVERY_LITE_EXECUTOR_ID ||
    !record.execution?.completedAt ||
    record.execution.outcomes.length !== 1 ||
    record.execution.outcomes[0]?.status !== 'succeeded' ||
    record.execution.outcomes[0].actionId !== CONTRACT_DELIVERY_LITE_EXECUTOR_ID
  ) {
    return blocked(
      'CONTRACT_DELIVERY_REHEARSAL_EVIDENCE_INVALID',
      'A succeeded reviewed Workflow plan is required to assemble rehearsal evidence.',
    );
  }
  const workflowPlan = workflowPlanFromActionInput(record.canonicalPlan.actions[0].input);
  assertContractDeliveryLiteWorkflowPlan(workflowPlan);
  const receipt = validateContractDeliveryLiteWorkflowReceipt(
    record.execution.outcomes[0].data,
    workflowPlan,
  );
  return Object.freeze({
    record,
    workflowPlan,
    receipt,
    evidenceRefs: record.execution.outcomes[0].evidenceRefs,
  });
}

export async function assembleContractDeliveryLiteRehearsalSource(
  input: AssembleContractDeliveryLiteRehearsalInput,
): Promise<ContractToDeliverySourceSnapshot> {
  const storedPlan = await new LocalGovernedPlanStore(input.governedPlanRoot).load(
    input.workflowPlanId,
  );
  if (!storedPlan) {
    return blocked(
      'CONTRACT_DELIVERY_REHEARSAL_EVIDENCE_INVALID',
      'The governed Workflow plan is unavailable.',
    );
  }
  const completed = completedWorkflowRecord(storedPlan);
  if (
    completed.receipt.scenarioInstanceId !== input.scenarioInstanceId ||
    completed.receipt.scenarioCorrelationId !== input.scenarioCorrelationId ||
    completed.workflowPlan.workflow.id !== CONTRACT_DELIVERY_LITE_WORKFLOW_ID
  ) {
    return blocked(
      'CONTRACT_DELIVERY_REHEARSAL_EVIDENCE_INVALID',
      'The governed Workflow receipt does not match the requested Scenario scope.',
    );
  }
  const scenario = await new LocalScenarioInstanceStore(
    input.scenarioInstanceRoot,
    input.scenarioCorrelationId,
  ).readWithRevision(input.scenarioInstanceId);
  if (
    !scenario ||
    scenario.instance.state !== 'completed' ||
    scenario.instance.definitionId !== CONTRACT_TO_DELIVERY_SCENARIO_ID ||
    !scenario.instance.workflowRunIds.includes(completed.receipt.workflowRunId)
  ) {
    return blocked(
      'CONTRACT_DELIVERY_REHEARSAL_EVIDENCE_INVALID',
      'The completed Scenario instance does not contain the governed Workflow receipt.',
    );
  }

  const generatedAt = completed.record.execution!.completedAt!;
  const cursor = `rehearsal:sha256:${createHash('sha256')
    .update(
      canonicalJson({
        scenarioRevision: scenario.revision,
        workflowPlanHash: completed.workflowPlan.planHash,
        executionId: completed.record.execution!.executionId,
        completedAt: generatedAt,
      }),
      'utf8',
    )
    .digest('hex')}`;
  const source = structuredClone(
    createContractToDeliveryDemoSource({
      scenarioInstanceId: input.scenarioInstanceId,
      cursor,
      generatedAt,
    }),
  ) as unknown as MutableContractSource;
  const batch = source.softwareDelivery.sources.workflowRuns;
  if (batch.status === 'missing') {
    return blocked(
      'CONTRACT_DELIVERY_REHEARSAL_EVIDENCE_INVALID',
      'The checked demo source has no Workflow evidence batch.',
    );
  }
  const eventIds = completed.evidenceRefs
    .filter((reference) => reference.startsWith('collaboration-event:'))
    .map((reference) => reference.slice('collaboration-event:'.length));
  if (eventIds.length !== 1) {
    return blocked(
      'CONTRACT_DELIVERY_REHEARSAL_EVIDENCE_INVALID',
      'The governed Workflow outcome does not bind one Collaboration event.',
    );
  }
  batch.batchVersion = `governed-local:${completed.workflowPlan.planHash}`;
  batch.observedAt = generatedAt;
  batch.warningCodes = [
    ...new Set([...(batch.warningCodes ?? []), 'governed_local_rehearsal_evidence']),
  ].sort();
  batch.items.push({
    id: completed.receipt.workflowRunId,
    authorityVersion: `governed-plan:${completed.record.planId}:revision:${completed.record.revision}`,
    observationKind: 'local_store',
    observedAt: generatedAt,
    sourceEventIds: eventIds,
    evidenceRefs: [
      `governed-plan:${completed.record.planId}`,
      `scenario-instance:${scenario.instance.id}@${scenario.revision}`,
    ],
    workflowId: CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
    status: 'completed',
    issueIds: [...completed.receipt.workItemIds],
    pullRequestIds: [...completed.receipt.deliverableIds],
    startedAt: completed.record.execution!.startedAt,
    completedAt: generatedAt,
  });
  return validateContractToDeliverySourceSnapshot(source);
}

export async function publishContractDeliveryLiteRehearsalSnapshot(
  input: PublishContractDeliveryLiteRehearsalInput,
): Promise<PublishedGraphBuildSnapshot> {
  const source = validateContractToDeliverySourceSnapshot(input.source);
  return buildAndPublishGraphSnapshot({
    scenarioId: CONTRACT_TO_DELIVERY_SCENARIO_ID,
    sourceBytes: Buffer.from(canonicalJson(source), 'utf8'),
    store: new LocalGraphStore(join(input.workspaceRoot, '.openslack.local', 'graph')),
    expectedCursor: input.expectedCursor,
    expectedScenarioInstanceId: source.scenarioInstanceId,
  });
}
