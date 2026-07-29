import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { WorkflowPlanResolverEntry, WorkflowStartPlan } from './governed-plan.js';

export const CONTRACT_DELIVERY_LITE_WORKFLOW_ID = 'contract.delivery.lite' as const;
export const CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION = '1.0.0' as const;
export const CONTRACT_DELIVERY_LITE_ADAPTER_ID = 'openslack.contract_delivery.local' as const;
export const CONTRACT_DELIVERY_LITE_EXECUTOR_ID = 'openslack.contract_delivery.local' as const;
export const CONTRACT_DELIVERY_LITE_FIXTURE_ID = 'contract-to-delivery-lite-example' as const;
export const CONTRACT_DELIVERY_LITE_CAPABILITIES = Object.freeze([
  'openslack.collaboration.recordEvent',
] as const);

export interface ContractDeliveryLiteWorkflowInput {
  readonly mode: 'local_rehearsal';
  readonly fixtureId: typeof CONTRACT_DELIVERY_LITE_FIXTURE_ID;
  readonly scenarioInstanceId: string;
  readonly scenarioCorrelationId: string;
}

export interface ContractDeliveryLiteWorkflowReceipt {
  readonly schema: 'openslack.contract_delivery_lite_rehearsal_receipt.v1';
  readonly evidenceLevel: 'LOCAL_REHEARSAL_PASS';
  readonly mode: 'local_rehearsal';
  readonly fixtureId: typeof CONTRACT_DELIVERY_LITE_FIXTURE_ID;
  readonly workflowId: typeof CONTRACT_DELIVERY_LITE_WORKFLOW_ID;
  readonly workflowVersion: typeof CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION;
  readonly workflowRunId: string;
  readonly scenarioInstanceId: string;
  readonly scenarioCorrelationId: string;
  readonly workItemIds: readonly ['issue-10'];
  readonly deliverableIds: readonly ['pr-20'];
  readonly acceptanceIds: readonly ['acceptance-current-head'];
  readonly outcomeIds: readonly ['outcome-contract-realized'];
  readonly origins: {
    readonly workflow: 'governed_local_store';
    readonly workItem: 'demo_fixture';
    readonly deliverable: 'demo_fixture';
    readonly acceptance: 'demo_fixture';
    readonly outcome: 'demo_fixture';
    readonly liveGitHub: 'not_run';
  };
}

export class ContractDeliveryLiteWorkflowError extends Error {
  readonly code:
    | 'CONTRACT_DELIVERY_WORKFLOW_INPUT_INVALID'
    | 'CONTRACT_DELIVERY_WORKFLOW_PLAN_INVALID';

  constructor(code: ContractDeliveryLiteWorkflowError['code'], message: string) {
    super(message);
    this.name = 'ContractDeliveryLiteWorkflowError';
    this.code = code;
  }
}

const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const HASH = /^[0-9a-f]{64}$/;
const CONTRACT = Object.freeze({
  schema: 'openslack.reviewed_workflow.v1',
  id: CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
  version: CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION,
  adapterId: CONTRACT_DELIVERY_LITE_ADAPTER_ID,
  executorId: CONTRACT_DELIVERY_LITE_EXECUTOR_ID,
  risk: 'low',
  capabilityIds: CONTRACT_DELIVERY_LITE_CAPABILITIES,
  authorityRequirements: Object.freeze([]),
  fixtureIds: Object.freeze([CONTRACT_DELIVERY_LITE_FIXTURE_ID]),
  outputSchema: 'openslack.contract_delivery_lite_rehearsal_receipt.v1',
});

export const CONTRACT_DELIVERY_LITE_WORKFLOW_HASH = createHash('sha256')
  .update(JSON.stringify(CONTRACT), 'utf8')
  .digest('hex');

function fail(code: ContractDeliveryLiteWorkflowError['code'], message: string): never {
  throw new ContractDeliveryLiteWorkflowError(code, message);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Readonly<Record<string, unknown>>)[key],
          )}`,
      )
      .join(',')}}`;
  }
  return fail(
    'CONTRACT_DELIVERY_WORKFLOW_PLAN_INVALID',
    'Contract-to-Delivery receipt is not canonical JSON data.',
  );
}

function safeRuntimeId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    !SAFE_RUNTIME_ID.test(value)
  ) {
    return fail(
      'CONTRACT_DELIVERY_WORKFLOW_INPUT_INVALID',
      `${label} is not a bounded runtime identifier.`,
    );
  }
  return value;
}

export function createContractDeliveryLiteWorkflowResolverEntry(): WorkflowPlanResolverEntry {
  return Object.freeze({
    id: CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
    version: CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION,
    adapterId: CONTRACT_DELIVERY_LITE_ADAPTER_ID,
    executorId: CONTRACT_DELIVERY_LITE_EXECUTOR_ID,
    workflowHash: CONTRACT_DELIVERY_LITE_WORKFLOW_HASH,
    risk: 'low',
    capabilityIds: CONTRACT_DELIVERY_LITE_CAPABILITIES,
    authorityRequirements: Object.freeze([]),
  });
}

export function normalizeContractDeliveryLiteWorkflowInput(
  value: unknown,
): ContractDeliveryLiteWorkflowInput {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail(
      'CONTRACT_DELIVERY_WORKFLOW_INPUT_INVALID',
      'Contract-to-Delivery workflow input must be inert data.',
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ['fixtureId', 'mode', 'scenarioCorrelationId', 'scenarioInstanceId'];
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expected.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !expected.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  ) {
    return fail(
      'CONTRACT_DELIVERY_WORKFLOW_INPUT_INVALID',
      'Contract-to-Delivery workflow input has missing or unknown fields.',
    );
  }
  if (
    descriptors.mode!.value !== 'local_rehearsal' ||
    descriptors.fixtureId!.value !== CONTRACT_DELIVERY_LITE_FIXTURE_ID
  ) {
    return fail(
      'CONTRACT_DELIVERY_WORKFLOW_INPUT_INVALID',
      'Only the reviewed credential-free local rehearsal fixture is registered.',
    );
  }
  return Object.freeze({
    mode: 'local_rehearsal',
    fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
    scenarioInstanceId: safeRuntimeId(descriptors.scenarioInstanceId!.value, 'scenarioInstanceId'),
    scenarioCorrelationId: safeRuntimeId(
      descriptors.scenarioCorrelationId!.value,
      'scenarioCorrelationId',
    ),
  });
}

export function assertContractDeliveryLiteWorkflowPlan(
  plan: WorkflowStartPlan,
): ContractDeliveryLiteWorkflowInput {
  if (
    plan.workflow.id !== CONTRACT_DELIVERY_LITE_WORKFLOW_ID ||
    plan.workflow.version !== CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION ||
    plan.workflow.adapterId !== CONTRACT_DELIVERY_LITE_ADAPTER_ID ||
    plan.workflow.executorId !== CONTRACT_DELIVERY_LITE_EXECUTOR_ID ||
    plan.workflow.workflowHash !== CONTRACT_DELIVERY_LITE_WORKFLOW_HASH ||
    plan.workflow.risk !== 'low' ||
    JSON.stringify(plan.workflow.capabilityIds) !==
      JSON.stringify(CONTRACT_DELIVERY_LITE_CAPABILITIES) ||
    plan.workflow.authorityRequirements.length !== 0 ||
    plan.authorityBindings.length !== 0 ||
    plan.effect.executorId !== CONTRACT_DELIVERY_LITE_EXECUTOR_ID ||
    plan.effect.workflowHash !== CONTRACT_DELIVERY_LITE_WORKFLOW_HASH ||
    plan.effect.inputHash !== plan.inputHash ||
    !HASH.test(plan.planHash)
  ) {
    return fail(
      'CONTRACT_DELIVERY_WORKFLOW_PLAN_INVALID',
      'Workflow plan does not match the reviewed Contract-to-Delivery binding.',
    );
  }
  return normalizeContractDeliveryLiteWorkflowInput(plan.normalizedInput);
}

export function deriveContractDeliveryLiteWorkflowRunId(plan: WorkflowStartPlan): string {
  assertContractDeliveryLiteWorkflowPlan(plan);
  return `workflow-run:sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'openslack.contract_delivery_lite_run_id.v1',
        workflowPlanHash: plan.planHash,
        scenarioInstanceId: (plan.normalizedInput as ContractDeliveryLiteWorkflowInput)
          .scenarioInstanceId,
      }),
      'utf8',
    )
    .digest('hex')}`;
}

export function createContractDeliveryLiteWorkflowReceipt(
  plan: WorkflowStartPlan,
): ContractDeliveryLiteWorkflowReceipt {
  const input = assertContractDeliveryLiteWorkflowPlan(plan);
  return Object.freeze({
    schema: 'openslack.contract_delivery_lite_rehearsal_receipt.v1',
    evidenceLevel: 'LOCAL_REHEARSAL_PASS',
    mode: 'local_rehearsal',
    fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
    workflowId: CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
    workflowVersion: CONTRACT_DELIVERY_LITE_WORKFLOW_VERSION,
    workflowRunId: deriveContractDeliveryLiteWorkflowRunId(plan),
    scenarioInstanceId: input.scenarioInstanceId,
    scenarioCorrelationId: input.scenarioCorrelationId,
    workItemIds: Object.freeze(['issue-10'] as const),
    deliverableIds: Object.freeze(['pr-20'] as const),
    acceptanceIds: Object.freeze(['acceptance-current-head'] as const),
    outcomeIds: Object.freeze(['outcome-contract-realized'] as const),
    origins: Object.freeze({
      workflow: 'governed_local_store',
      workItem: 'demo_fixture',
      deliverable: 'demo_fixture',
      acceptance: 'demo_fixture',
      outcome: 'demo_fixture',
      liveGitHub: 'not_run',
    }),
  });
}

export function validateContractDeliveryLiteWorkflowReceipt(
  value: unknown,
  plan: WorkflowStartPlan,
): ContractDeliveryLiteWorkflowReceipt {
  const expected = createContractDeliveryLiteWorkflowReceipt(plan);
  if (canonicalJson(value) !== canonicalJson(expected)) {
    return fail(
      'CONTRACT_DELIVERY_WORKFLOW_PLAN_INVALID',
      'Workflow receipt does not match the reviewed Contract-to-Delivery plan.',
    );
  }
  return expected;
}
