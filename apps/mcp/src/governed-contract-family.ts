import { fileURLToPath } from 'node:url';
import type { BoundCollaborationEventAppender } from '@openslack/collaboration';
import { authorizeAgentAction, type AgentPermissionSnapshot } from '@openslack/kernel';
import { LocalScenarioInstanceStore, type LoadedScenarioDefinition, type ScenarioHostCatalog } from '@openslack/scenario-runtime';
import { assertContractDeliveryLiteWorkflowPlan, rehydrateWorkflowStartPlan, createContractDeliveryLiteWorkflowResolverEntry,
  CONTRACT_DELIVERY_LITE_ADAPTER_ID, CONTRACT_DELIVERY_LITE_CAPABILITIES, CONTRACT_DELIVERY_LITE_WORKFLOW_HASH,
  CONTRACT_DELIVERY_LITE_WORKFLOW_ID, CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION } from '@openslack/workflows';
import type { WorkflowStartPlan } from '@openslack/workflows';
import type { GovernedWorkflowFamily, WorkflowFamilyObservation } from './governed-workflow-family.js';
import { CONTRACT_DELIVERY_REHEARSAL_BUILD_SOURCE_PATH, executeContractDeliveryLiteWorkflow } from './contract-delivery-rehearsal.js';
import { OpenSlackMcpToolError } from './errors.js';

interface ContractFamilyOptions {
  catalog: ScenarioHostCatalog;
  scenarioInstanceRoot: string;
  eventAppender: BoundCollaborationEventAppender;
  provider: Parameters<typeof executeContractDeliveryLiteWorkflow>[0]['provider'];
  definitions(): Promise<ReadonlyMap<string, LoadedScenarioDefinition>>;
  sources(definitions: ReadonlyMap<string, LoadedScenarioDefinition>): Readonly<Record<string, unknown>>;
}

export function authorizeContractWorkflow(snapshot: AgentPermissionSnapshot): void {
  for (const action of ['scenario.instantiate', ...CONTRACT_DELIVERY_LITE_CAPABILITIES]) {
    if (authorizeAgentAction({ snapshot, action, riskZone: 'yellow' }).decision !== 'allow') {
      throw new OpenSlackMcpToolError('GOVERNED_ACTION_NOT_AUTHORIZED', 'The current agent principal is not granted the reviewed local Workflow capability.', 'blocked');
    }
  }
}

export function createContractWorkflowFamily(options: ContractFamilyOptions): GovernedWorkflowFamily {
  const reviewed = createContractDeliveryLiteWorkflowResolverEntry();
  const workflow = options.catalog.workflow(CONTRACT_DELIVERY_LITE_WORKFLOW_ID);
  const adapter = options.catalog.adapter(CONTRACT_DELIVERY_LITE_ADAPTER_ID);
  if (!workflow || workflow.version !== CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION || workflow.adapterId !== CONTRACT_DELIVERY_LITE_ADAPTER_ID ||
    JSON.stringify(workflow.capabilityIds) !== JSON.stringify(CONTRACT_DELIVERY_LITE_CAPABILITIES) || !adapter || adapter.kind !== 'workflow' ||
    JSON.stringify(adapter.capabilityIds) !== JSON.stringify(CONTRACT_DELIVERY_LITE_CAPABILITIES)) {
    throw new OpenSlackMcpToolError('GOVERNED_WORKFLOW_BINDING_CHANGED', 'The reviewed Contract-to-Delivery Workflow catalog binding is unavailable.', 'blocked');
  }
  const observe = async (plan: WorkflowStartPlan): Promise<WorkflowFamilyObservation> => {
    const input = assertContractDeliveryLiteWorkflowPlan(plan);
    const definitions = await options.definitions();
    const definition = definitions.get('contract-to-delivery-lite');
    const scenario = await new LocalScenarioInstanceStore(options.scenarioInstanceRoot, input.scenarioCorrelationId).readWithRevision(input.scenarioInstanceId);
    if (!definition || !scenario || scenario.instance.state !== 'active' || scenario.instance.definitionId !== definition.manifest.id || scenario.instance.definitionHash !== definition.definitionHash) {
      throw new OpenSlackMcpToolError('GOVERNED_WORKFLOW_SCENARIO_NOT_ACTIVE', 'The reviewed Workflow requires its active locked Contract-to-Delivery Scenario.', 'blocked');
    }
    return { subject: { kind: 'workflow.start', workflowPlanHash: plan.planHash,
      scenarioInstanceId: scenario.instance.id, scenarioInstanceRevision: scenario.revision, scenarioDefinitionHash: definition.definitionHash },
    sources: options.sources(definitions), stores: { scenarioInstance: 'openslack.scenario_instance.v1' } };
  };
  return Object.freeze({ id: 'contract-delivery-local', description: 'Execute the reviewed credential-free Contract-to-Delivery local rehearsal and persist its evidence.',
    entries: Object.freeze([reviewed]), buildSources: Object.freeze([fileURLToPath(import.meta.url), CONTRACT_DELIVERY_REHEARSAL_BUILD_SOURCE_PATH]),
    authorize: authorizeContractWorkflow,
    restore(plan, resolver, authority) {
      return rehydrateWorkflowStartPlan(plan, { resolver, planHash: plan.planHash, actorId: authority.actorId,
        workspaceId: authority.workspaceId, correlationId: authority.correlationId,
        workflowHash: CONTRACT_DELIVERY_LITE_WORKFLOW_HASH, now: new Date().toISOString() });
    },
    observe,
    async compile(plan) {
      const observation = await observe(plan);
      return { kind: 'workflow.start', goal: 'Run the reviewed credential-free Contract-to-Delivery local rehearsal.',
        input: { workflowId: plan.workflow.id, normalizedInput: plan.normalizedInput },
        actions: [{ actionId: plan.workflow.executorId, input: { workflowPlan: plan } }],
        effects: [{ type: 'workflow.start', summary: `Start reviewed Workflow ${plan.workflow.id}.`, risk: plan.risk, target: String(observation.subject.scenarioInstanceId) }] };
    },
    async execute(plan, context) {
      await observe(plan);
      const definition = (await options.definitions()).get('contract-to-delivery-lite');
      if (!definition) throw new OpenSlackMcpToolError('GOVERNED_WORKFLOW_BINDING_CHANGED', 'The locked Contract-to-Delivery Scenario definition is unavailable.', 'blocked');
      const execution = await executeContractDeliveryLiteWorkflow({ workflowPlan: plan, context, definition,
        scenarioInstanceRoot: options.scenarioInstanceRoot, eventAppender: options.eventAppender, provider: options.provider });
      return { status: 'succeeded', summary: 'The reviewed Contract-to-Delivery local Workflow completed with durable evidence.',
        data: execution.receipt, evidenceRefs: execution.evidenceRefs };
    },
  } satisfies GovernedWorkflowFamily);
}
