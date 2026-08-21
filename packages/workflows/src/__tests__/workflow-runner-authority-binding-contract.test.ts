import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_RECEIPT_SCHEMAS,
  WorkflowRunnerAuthorityBindingContractError,
  hashWorkflowRunnerAuthorityBindingEvidence,
  hashWorkflowRunnerAuthorityBindingReceipt,
  hashWorkflowRunnerAuthorityBindingResolution,
  hashWorkflowRunnerAuthorityBindingStage,
  hashWorkflowRunnerBudgetSourceReceipt,
  parseWorkflowRunnerAuthorityBindingReceiptBytes,
  parseWorkflowRunnerAuthorityBindingResolutionBytes,
  parseWorkflowRunnerAuthorityBindingStageBytes,
  parseWorkflowRunnerAuthorityBindingErrorBytes,
  prepareWorkflowRunnerAuthorityBindingError,
  prepareWorkflowRunnerAuthorityBindingReceipt,
  prepareWorkflowRunnerAuthorityBindingResolution,
  prepareWorkflowRunnerAuthorityBindingStage,
  validateWorkflowRunnerAuthorityBindingReceipt,
  validateWorkflowRunnerAuthorityBindingResolution,
  validateWorkflowRunnerAuthorityBindingResolutionForStage,
  validateWorkflowRunnerAuthorityBindingResolutionReceipt,
  validateWorkflowRunnerAuthorityBindingStage,
  validateWorkflowRunnerAuthorityBindingStageReceipt,
  validateWorkflowRunnerAuthorityBindingError,
  validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage as validateWorkflowRunnerAuthorityControlDeliveryReceiptWithContext,
  validateWorkflowRunnerBudgetSourceResult,
  workflowRunnerAuthorityBindingExpectedKind,
  workflowRunnerAuthorityBindingRunnerDelta,
  type WorkflowRunnerAuthorityBindingOperation,
} from '../workflow-runner-authority-binding-contract.js';
import {
  canonicalWorkflowBudgetAuthorityJson,
  prepareWorkflowBudgetAuthorityRequest,
  type WorkflowBudgetSettlementRequest,
} from '../workflow-budget-authority-contract.js';
import {
  withWorkflowRunnerAuthorityBindingEncodingObserver,
  withWorkflowRunnerAuthorityBindingValidationObserver,
} from '../internal/workflow-runner-authority-binding-instrumentation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const bundleRoot = resolve(
  root,
  'packages/workflows/contracts/workflow-runner-authority-binding/v1',
);
const load = (path: string) => JSON.parse(readFileSync(resolve(bundleRoot, path), 'utf8')) as Json;
const sha = (path: string) =>
  createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');

type Json = Record<string, unknown>;

function validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
  receipt: unknown,
  message: unknown,
  stage: unknown,
  resolution: unknown,
  resolutionReceipt: unknown,
  stageReceipt: unknown,
  priorEventDelivery: unknown,
  budgetSourceResult: unknown = null,
) {
  return validateWorkflowRunnerAuthorityControlDeliveryReceiptWithContext(receipt, message, {
    stage,
    resolution,
    resolutionReceipt,
    stageReceipt,
    priorEventDelivery,
    budgetSourceResult,
  });
}

function asJson(value: unknown, label: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Json;
}

interface ExactVector {
  readonly value: unknown;
  readonly canonicalBytes: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly prepared: {
    readonly schema: string;
    readonly bodyHash: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
  };
}

interface ExchangeVectors {
  readonly stage: ExactVector;
  readonly stageReceipt: ExactVector;
  readonly resolution: ExactVector;
  readonly resolutionReceipt: ExactVector;
}

interface ControlDeliveryArtifact {
  readonly operation: WorkflowRunnerAuthorityBindingOperation;
  readonly message: unknown;
  readonly receipt: ExactVector;
  readonly budgetSourceResult: unknown | null;
  readonly priorEventDeliveryRef: string | null;
}

interface Golden {
  readonly sourceLocks: Record<string, string>;
  readonly operationMatrix: Array<{
    operation: WorkflowRunnerAuthorityBindingOperation;
    targetKind: string;
    runnerDelta: { revision: number; generation: number };
    sourceEvidenceState: 'prepared' | 'committed';
    sourcePlane: 'checkpoint_control' | 'effect_v2_sibling' | 'budget_account' | 'resume_control';
    sourceRevisionDelta: number;
    sourceGenerationDelta: number;
    sourceReceiptSchema: string | null;
    authorityReceiptHashAlgorithm:
      | 'binding_receipt_domain_sha256'
      | 'canonical_durable_receipt_sha256'
      | null;
  }>;
  readonly positive: {
    readonly operations: Record<WorkflowRunnerAuthorityBindingOperation, ExchangeVectors>;
    readonly semanticVariants: Record<string, ExchangeVectors>;
    readonly controlDelivery: {
      readonly accepted: Record<WorkflowRunnerAuthorityBindingOperation, ExactVector>;
      readonly reconciliationRequired: ExactVector;
      readonly artifacts: Record<string, ControlDeliveryArtifact>;
      readonly priorEventDeliveries: Record<
        string,
        { readonly message: unknown; readonly receipt: ExactVector }
      >;
      readonly byKind: Record<
        | 'event_receipt'
        | 'budget_authorization'
        | 'effect_authorization'
        | 'resume_offer'
        | 'cancel_request',
        string
      >;
      readonly budgetAuthorization: Record<'reserved' | 'rejected', string>;
      readonly budgetDatabaseReconciliation: {
        readonly message: unknown;
        readonly receipt: ExactVector;
        readonly decision: null;
      };
      readonly messages: {
        readonly accepted: Record<WorkflowRunnerAuthorityBindingOperation, unknown>;
        readonly reconciliationRequired: unknown;
      };
    };
  };
  readonly negative: Array<{
    readonly id: string;
    readonly operation: string;
    readonly input: Json;
    readonly expectedError: { readonly code: string; readonly path: string };
  }>;
}

const golden = load('golden-vectors.json') as unknown as Golden;
const manifest = load('manifest.json');

function controlArtifact(reference: string): ControlDeliveryArtifact {
  const artifact = golden.positive.controlDelivery.artifacts[reference];
  if (artifact === undefined) {
    throw new Error(`Missing control delivery artifact ${reference}.`);
  }
  return artifact;
}

function namedPriorDelivery(reference: string | null): unknown {
  if (reference === null) return null;
  const prior = golden.positive.controlDelivery.priorEventDeliveries[reference];
  if (prior === undefined) throw new Error(`Missing prior delivery artifact ${reference}.`);
  exact(prior.receipt, 'receipt');
  return { message: prior.message, receipt: prior.receipt.value };
}

function exact(vector: ExactVector, domain: 'stage' | 'resolution' | 'receipt'): unknown {
  const prepared =
    domain === 'stage'
      ? prepareWorkflowRunnerAuthorityBindingStage(vector.value)
      : domain === 'resolution'
        ? prepareWorkflowRunnerAuthorityBindingResolution(vector.value)
        : prepareWorkflowRunnerAuthorityBindingReceipt(vector.value);
  expect(prepared.body).toBe(vector.canonicalBytes);
  expect(Buffer.byteLength(prepared.body)).toBe(vector.byteLength);
  expect(createHash('sha256').update(prepared.body).digest('hex')).toBe(vector.sha256);
  expect({
    schema: prepared.schema,
    bodyHash: prepared.bodyHash,
    idempotencyKey: prepared.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
  }).toEqual(vector.prepared);
  return prepared.value;
}

function executeNegative(operation: string, input: Json): unknown {
  switch (operation) {
    case 'validate_stage':
      return validateWorkflowRunnerAuthorityBindingStage(input);
    case 'validate_resolution':
      return validateWorkflowRunnerAuthorityBindingResolution(input);
    case 'validate_stage_receipt':
      return validateWorkflowRunnerAuthorityBindingStageReceipt(input.receipt, input.stage);
    case 'validate_resolution_receipt':
      return validateWorkflowRunnerAuthorityBindingResolutionReceipt(
        input.receipt,
        input.resolution,
        input.stage,
        input.stageReceipt,
      );
    case 'validate_control_delivery':
      return validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
        input.receipt,
        input.message,
        input.stage,
        input.resolution,
        input.resolutionReceipt,
        input.stageReceipt,
        input.priorEventDelivery,
        input.budgetSourceResult ?? null,
      );
    case 'validate_budget_source_result':
      return validateWorkflowRunnerBudgetSourceResult(input.sourceResult, input.preparedRequest);
    case 'validate_resolution_for_stage':
      return validateWorkflowRunnerAuthorityBindingResolutionForStage(
        input.resolution,
        input.stage,
        input.stageReceipt,
      );
    default:
      throw new Error(`Unknown negative operation ${operation}.`);
  }
}

function schemaValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  for (const path of (manifest.bundleFiles as string[]).filter((entry) =>
    entry.startsWith('schemas/'),
  )) {
    ajv.addSchema(load(path));
  }
  return ajv;
}

describe('Workflow Runner GS9-F2a authority-binding contract', () => {
  it('freezes six companion operations without extending the frozen 18-kind v2 protocol', () => {
    expect(WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION).toBe(
      'openslack.workflow_runner_authority_binding.v1',
    );
    expect(WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE).toBe(
      'workflow-control-runner-v2-runtime-delivery-v1',
    );
    expect(WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS).toEqual([
      'checkpoint_commit',
      'effect_authorize',
      'effect_complete',
      'budget_reserve',
      'budget_settle',
      'resume_advance',
    ]);
    expect(manifest.authorityBoundary).toEqual({
      batch: 'GS9-F2a',
      normative: true,
      contractOnly: true,
      qualificationOnly: true,
      authorityClaim: 'NO_AUTHORITY',
      goAuthorityImplemented: false,
      runtimeCompositionImplemented: false,
      productionRoutingActivated: false,
      frozenAuthorityV2KindsExtended: false,
      frozenAuthorityV2KindCount: 18,
      sourceAuthoritiesReplaced: false,
      notDelivered: [
        'migration_000008',
        'database',
        'http',
        'durable_store',
        'scheduler',
        'worker',
        'checkpoint_adapter',
        'effect_adapter',
        'budget_adapter',
        'resume_adapter',
        'provider_adapter',
        'authority_recovery',
        'runtime_composition',
      ],
      notActivated: [
        'future_runtime_profile',
        'production_v2_submission',
        'new_record_acceptance',
        'routing',
        'canary',
        'cutover',
        'typescript_fallback_removal',
        'typescript_writer_retirement',
      ],
      notClaimed: [
        'runtime_authority_delivery',
        'go_production_workflow_authority',
        'go_production_checkpoint_authority',
        'go_production_effect_authority',
        'go_production_budget_policy_authority',
        'go_production_provider_authority',
        'go_production_run_store_authority',
        'go_production_user_visible_read_authority',
        'authenticated_external_host_qualification',
        'qoder',
        'remote_connector',
        'release',
        'live',
        'tag',
        'npm',
        'production_readiness',
      ],
      separateGates: [
        'hosted_exact_head_checks',
        'review_thread_resolution',
        'independent_human_approval',
        'merge',
      ],
    });
    expect(manifest.budgetDecisionDelivery).toEqual({
      sourceResultRequired: true,
      durableReceiptSchema: 'openslack.workflow_control_budget_durable_record.v1',
      authorityReceiptHash: 'canonical_durable_receipt_sha256',
      acceptedStates: {
        reserved: 'requested_amounts',
        rejected: 'zero_amounts',
      },
      databaseReconciliationRequired: {
        delivery: 'event_receipt_only',
        budgetAuthorizationAllowed: false,
        reason: 'accepted_run_revision_null',
      },
    });
  });

  it('pins every source manifest and the immutable 000007 migration bytes', () => {
    expect(golden.sourceLocks).toEqual(WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS);
    for (const [name, lock] of Object.entries(manifest.sourceLocks as Json)) {
      const record = lock as { path: string; sha256: string };
      expect(record.sha256, name).toBe(
        WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS[
          name as keyof typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS
        ],
      );
      expect(sha(record.path), name).toBe(record.sha256);
    }
  });

  it('keeps the generated inventory exact, closed, and free of untracked bundle artifacts', () => {
    const actual = [
      ...readdirSync(resolve(bundleRoot, 'schemas')).map((name) => `schemas/${name}`),
      ...readdirSync(bundleRoot).filter((name) => name.endsWith('.json')),
    ].sort();
    expect(actual).toEqual([...(manifest.bundleFiles as string[])].sort());
    expect(Object.keys(manifest.artifacts as Json)).toHaveLength(5);
    expect(manifest.evidence).toMatchObject({
      closed: true,
      providerIdentity: 'hash_only',
      resultIdentity: 'hash_only',
    });
  });

  it('round-trips all six exact two-stage exchanges and their independent companion sequence', () => {
    for (const operation of WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS) {
      const vectors = golden.positive.operations[operation];
      const stage = exact(vectors.stage, 'stage');
      const stageReceipt = exact(vectors.stageReceipt, 'receipt');
      const resolution = exact(vectors.resolution, 'resolution');
      const resolutionReceipt = exact(vectors.resolutionReceipt, 'receipt');
      expect(validateWorkflowRunnerAuthorityBindingStageReceipt(stageReceipt, stage)).toEqual(
        stageReceipt,
      );
      expect(
        validateWorkflowRunnerAuthorityBindingResolutionForStage(resolution, stage, stageReceipt),
      ).toEqual(resolution);
      expect(
        validateWorkflowRunnerAuthorityBindingResolutionReceipt(
          resolutionReceipt,
          resolution,
          stage,
          stageReceipt,
        ),
      ).toEqual(resolutionReceipt);
      expect((stage as { companionSequence: number }).companionSequence).toBe(1);
      expect((resolution as { companionSequence: number }).companionSequence).toBe(2);
    }
  });

  it('separates coordinator and source revisions with the exact operation delta matrix', () => {
    expect(golden.operationMatrix).toEqual(
      WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) => ({
        operation,
        ...WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation],
      })),
    );
    expect(manifest.operations).toEqual(golden.operationMatrix);
    for (const row of golden.operationMatrix) {
      expect(row.targetKind).toBe(workflowRunnerAuthorityBindingExpectedKind(row.operation));
      expect(row.runnerDelta).toEqual(workflowRunnerAuthorityBindingRunnerDelta(row.operation));
      expect(row.sourceReceiptSchema).toBe(
        WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_RECEIPT_SCHEMAS[row.operation],
      );
      if (row.operation === 'effect_complete') expect(row.runnerDelta.revision).toBe(0);
      if (row.operation === 'resume_advance') {
        expect(row.runnerDelta).toEqual({ revision: 1, generation: 1 });
        expect(row.sourceGenerationDelta).toBe(1);
      }
      if (row.operation.startsWith('budget_')) {
        expect(row.sourceEvidenceState).toBe('prepared');
        expect(row.sourceRevisionDelta).toBe(0);
      }
    }
  });

  it('covers closed effect and budget reconciliation evidence states', () => {
    const expected = [
      'effectAuthorizeRejected',
      'effectAuthorizeExpired',
      'effectCompleteFailed',
      'effectCompleteReconciliation',
      'budgetSettleMissing',
      'budgetSettleUntrusted',
      'budgetSettleProviderUnreported',
      'goRouteCheckpoint',
      'budgetReserveGoAuthority',
    ];
    expect(Object.keys(golden.positive.semanticVariants)).toEqual(expected);
    for (const [name, vectors] of Object.entries(golden.positive.semanticVariants)) {
      const stage = exact(vectors.stage, 'stage');
      const stageReceipt = exact(vectors.stageReceipt, 'receipt');
      const resolution = exact(vectors.resolution, 'resolution');
      const resolutionReceipt = exact(vectors.resolutionReceipt, 'receipt');
      expect(
        validateWorkflowRunnerAuthorityBindingResolutionForStage(resolution, stage, stageReceipt),
        name,
      ).toEqual(resolution);
      expect(
        validateWorkflowRunnerAuthorityBindingResolutionReceipt(
          resolutionReceipt,
          resolution,
          stage,
          stageReceipt,
        ),
        name,
      ).toEqual(resolutionReceipt);
    }
  });

  it('binds accepted E1 reserve results through the exact durable receipt outer', () => {
    const exchange = golden.positive.semanticVariants.budgetReserveGoAuthority;
    const prepared = asJson(
      asJson(exchange.resolution.value, 'budget resolution').evidence,
      'budget evidence',
    ).preparedRequest;
    for (const [status, reference] of Object.entries(
      golden.positive.controlDelivery.budgetAuthorization,
    )) {
      const item = controlArtifact(reference);
      expect(
        validateWorkflowRunnerBudgetSourceResult(item.budgetSourceResult, prepared),
        status,
      ).toEqual(item.budgetSourceResult);
      const source = asJson(item.budgetSourceResult, 'budget source result');
      expect(hashWorkflowRunnerBudgetSourceReceipt(source.durableReceiptBytes), status).toBe(
        createHash('sha256').update(String(source.durableReceiptBytes)).digest('hex'),
      );
      const receipt = exact(item.receipt, 'receipt');
      expect(
        validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
          receipt,
          item.message,
          exchange.stage.value,
          exchange.resolution.value,
          exchange.resolutionReceipt.value,
          exchange.stageReceipt.value,
          {
            ...(namedPriorDelivery(item.priorEventDeliveryRef) as Json),
          },
          item.budgetSourceResult,
        ),
        status,
      ).toEqual(receipt);
      const payload = asJson(asJson(item.message, 'message').payload, 'payload');
      expect(payload.status).toBe(status);
      expect(payload.authorizedCalls).toBe(status === 'reserved' ? '1' : '0');
    }
  });

  it('acks all five exact control kinds after the event-receipt ACK and preserves reconciliation', () => {
    const deliveries = golden.positive.controlDelivery;
    for (const operation of WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS) {
      const receipt = exact(deliveries.accepted[operation], 'receipt');
      const exchange = golden.positive.operations[operation];
      expect(
        validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
          receipt,
          deliveries.messages.accepted[operation],
          exchange.stage.value,
          exchange.resolution.value,
          exchange.resolutionReceipt.value,
          exchange.stageReceipt.value,
          null,
        ),
      ).toEqual(receipt);
      expect((receipt as { companionSequence: number }).companionSequence).toBe(3);
    }
    expect(Object.keys(deliveries.byKind)).toEqual([
      'event_receipt',
      'budget_authorization',
      'effect_authorization',
      'resume_offer',
      'cancel_request',
    ]);
    for (const [kind, reference] of Object.entries(deliveries.byKind)) {
      const item = controlArtifact(reference);
      const exchange =
        kind === 'budget_authorization'
          ? golden.positive.semanticVariants.budgetReserveGoAuthority
          : golden.positive.operations[item.operation];
      const receipt = exact(item.receipt, 'receipt');
      expect(
        validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
          receipt,
          item.message,
          exchange.stage.value,
          exchange.resolution.value,
          exchange.resolutionReceipt.value,
          exchange.stageReceipt.value,
          kind === 'event_receipt'
            ? null
            : kind === 'budget_authorization'
              ? namedPriorDelivery(item.priorEventDeliveryRef)
              : {
                  message: deliveries.messages.accepted[item.operation],
                  receipt: deliveries.accepted[item.operation].value,
                },
          item.budgetSourceResult,
        ),
        kind,
      ).toEqual(receipt);
      expect((receipt as { companionSequence: number }).companionSequence).toBe(
        kind === 'event_receipt' ? 3 : 4,
      );
    }
    const reconciliation = exact(deliveries.reconciliationRequired, 'receipt') as {
      disposition: string;
    };
    expect(reconciliation.disposition).toBe('reconciliation_required');
    const cancel = controlArtifact(deliveries.byKind.cancel_request);
    const exchange = golden.positive.operations[cancel.operation];
    expect(
      validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
        reconciliation,
        deliveries.messages.reconciliationRequired,
        exchange.stage.value,
        exchange.resolution.value,
        exchange.resolutionReceipt.value,
        exchange.stageReceipt.value,
        {
          message: deliveries.messages.accepted[cancel.operation],
          receipt: deliveries.accepted[cancel.operation].value,
        },
      ),
    ).toEqual(reconciliation);

    const databaseUnknown = deliveries.budgetDatabaseReconciliation;
    const budgetExchange = golden.positive.semanticVariants.budgetReserveGoAuthority;
    const databaseReceipt = exact(databaseUnknown.receipt, 'receipt') as {
      disposition: string;
      companionSequence: number;
    };
    expect(
      validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
        databaseReceipt,
        databaseUnknown.message,
        budgetExchange.stage.value,
        budgetExchange.resolution.value,
        budgetExchange.resolutionReceipt.value,
        budgetExchange.stageReceipt.value,
        null,
        null,
      ),
    ).toEqual(databaseReceipt);
    expect(databaseReceipt).toMatchObject({
      disposition: 'reconciliation_required',
      companionSequence: 3,
    });
    expect(databaseUnknown.decision).toBeNull();
  });

  it('keeps runtime validators and all four closed JSON Schemas aligned', () => {
    const ajv = schemaValidator();
    const ids = {
      stage:
        'https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-authority-binding-stage.v1.schema.json',
      resolution:
        'https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-authority-binding-resolution.v1.schema.json',
      receipt:
        'https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-authority-binding-receipt.v1.schema.json',
      error:
        'https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-authority-binding-error.v1.schema.json',
    } as const;
    const exchanges = [
      ...Object.values(golden.positive.operations),
      ...Object.values(golden.positive.semanticVariants),
    ];
    for (const [index, vectors] of exchanges.entries()) {
      for (const [kind, vector] of [
        ['stage', vectors.stage],
        ['receipt', vectors.stageReceipt],
        ['resolution', vectors.resolution],
        ['receipt', vectors.resolutionReceipt],
      ] as const) {
        const validator = ajv.getSchema(ids[kind])!;
        expect(
          validator(vector.value),
          `${index}/${kind}: ${ajv.errorsText(validator.errors)}`,
        ).toBe(true);
      }
    }
    for (const vector of Object.values(golden.positive.controlDelivery.accepted)) {
      const validator = ajv.getSchema(ids.receipt)!;
      expect(validator(vector.value), ajv.errorsText(validator.errors)).toBe(true);
    }
    for (const reference of Object.values(golden.positive.controlDelivery.byKind)) {
      const item = controlArtifact(reference);
      const validator = ajv.getSchema(ids.receipt)!;
      expect(validator(item.receipt.value), ajv.errorsText(validator.errors)).toBe(true);
    }
    for (const reference of Object.values(golden.positive.controlDelivery.budgetAuthorization)) {
      const item = controlArtifact(reference);
      const validator = ajv.getSchema(ids.receipt)!;
      expect(validator(item.receipt.value), ajv.errorsText(validator.errors)).toBe(true);
      const prior =
        golden.positive.controlDelivery.priorEventDeliveries[item.priorEventDeliveryRef!];
      expect(validator(prior!.receipt.value), ajv.errorsText(validator.errors)).toBe(true);
    }
    expect(
      ajv.getSchema(ids.receipt)!(
        golden.positive.controlDelivery.budgetDatabaseReconciliation.receipt.value,
      ),
      ajv.errorsText(ajv.getSchema(ids.receipt)!.errors),
    ).toBe(true);
    const open = structuredClone(golden.positive.operations.checkpoint_commit.stage.value) as Json;
    open.unexpected = true;
    expect(ajv.getSchema(ids.stage)!(open)).toBe(false);
    const sensitive = golden.negative.find(({ id }) => id === 'raw-provider-forbidden')!;
    expect(ajv.getSchema(ids.resolution)!(sensitive.input)).toBe(false);
    const closedError = {
      schema: 'openslack.workflow_runner_authority_binding_error.v1',
      code: WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES[0],
      message: 'closed contract failure',
      bindingId: null,
      operation: null,
      reconciliationToken: null,
    };
    expect(ajv.getSchema(ids.error)!(closedError)).toBe(true);
    expect(ajv.getSchema(ids.error)!({ ...closedError, credential: 'forbidden' })).toBe(false);

    const goStage = golden.positive.semanticVariants.goRouteCheckpoint.stage.value;
    expect(validateWorkflowRunnerAuthorityBindingStage(goStage)).toEqual(goStage);
    expect(ajv.getSchema(ids.stage)!(goStage), ajv.errorsText(ajv.errors)).toBe(true);
    const routeMismatch = structuredClone(goStage) as Json;
    asJson(routeMismatch.route, 'route').authority = 'typescript';
    expect(() => validateWorkflowRunnerAuthorityBindingStage(routeMismatch)).toThrow(
      WorkflowRunnerAuthorityBindingContractError,
    );
    expect(ajv.getSchema(ids.stage)!(routeMismatch)).toBe(false);

    const phaseReconciliation = structuredClone(
      golden.positive.operations.checkpoint_commit.stageReceipt.value,
    ) as Json;
    phaseReconciliation.status = 'reconciliation_required';
    phaseReconciliation.committedAt = null;
    phaseReconciliation.reconciliationToken = 'reconcile.phase.contract';
    expect(validateWorkflowRunnerAuthorityBindingReceipt(phaseReconciliation)).toEqual(
      phaseReconciliation,
    );
    expect(
      ajv.getSchema(ids.receipt)!(phaseReconciliation),
      ajv.errorsText(ajv.getSchema(ids.receipt)!.errors),
    ).toBe(true);
    const inconsistentPhase = { ...phaseReconciliation, committedAt: '2026-08-20T00:01:01.000Z' };
    expect(() => validateWorkflowRunnerAuthorityBindingReceipt(inconsistentPhase)).toThrow(
      WorkflowRunnerAuthorityBindingContractError,
    );
    expect(ajv.getSchema(ids.receipt)!(inconsistentPhase)).toBe(false);

    const invalidControlStatus = structuredClone(
      controlArtifact(golden.positive.controlDelivery.byKind.event_receipt).receipt.value,
    ) as Json;
    invalidControlStatus.status = 'reconciliation_required';
    invalidControlStatus.committedAt = null;
    invalidControlStatus.reconciliationToken = 'reconcile.delivery.invalid';
    expect(() => validateWorkflowRunnerAuthorityBindingReceipt(invalidControlStatus)).toThrow(
      WorkflowRunnerAuthorityBindingContractError,
    );
    expect(ajv.getSchema(ids.receipt)!(invalidControlStatus)).toBe(false);

    const invalidRate = golden.negative.find(({ id }) => id === 'budget-rate-invalid')!;
    expect(() => validateWorkflowRunnerAuthorityBindingResolution(invalidRate.input)).toThrow(
      WorkflowRunnerAuthorityBindingContractError,
    );
    expect(ajv.getSchema(ids.resolution)!(invalidRate.input)).toBe(false);
  });

  it('replays every frozen negative with the same stable code and JSON path', () => {
    expect(golden.negative.map(({ id }) => id)).toEqual([
      'stage-unknown-field',
      'runner-revision-drift',
      'resolution-evidence-hash-drift',
      'stage-receipt-cross-splice',
      'resolution-receipt-cross-splice',
      'control-delivery-digest-drift',
      'raw-provider-forbidden',
      'resume-generation-drift',
      'source-global-revision-swap',
      'stage-before-resolution',
      'same-key-body-drift',
      'target-body-cross-splice',
      'target-key-cross-splice',
      'target-fingerprint-cross-splice',
      'resolution-alien-stage-receipt',
      'resolution-alien-stage-hash',
      'resolution-receipt-alien-stage-receipt',
      'resolution-receipt-stage-hash-drift',
      'checkpoint-nested-contract-error',
      'checkpoint-deep-path-contract-error',
      'budget-nested-contract-error',
      'effect-approved-expiry-boundary',
      'effect-expired-future-boundary',
      'effect-rejected-expiry-boundary',
      'control-event-receipt-target-drift',
      'control-decision-budget-evidence-drift',
      'budget-decision-source-missing',
      'budget-decision-source-null',
      'non-budget-decision-source-present',
      'budget-decision-status-drift',
      'budget-decision-amount-drift',
      'budget-decision-receipt-hash-drift',
      'budget-decision-committed-run-revision-drift',
      'budget-decision-source-result-cross-splice',
      'budget-durable-manifest-drift',
      'budget-durable-build-drift',
      'budget-durable-projection-hash-drift',
      'budget-source-ts-local-go-outer-cross-splice',
      'budget-durable-bytes-whitespace-drift',
      'budget-durable-bytes-duplicate-key-drift',
      'budget-durable-bytes-trailing-drift',
      'budget-durable-bytes-size-overflow',
      'budget-decision-database-unknown-no-seq4',
      'budget-decision-source-before-resolution-ack',
      'budget-decision-time-inversion',
      'control-decision-effect-evidence-drift',
      'control-decision-resume-attempt-drift',
      'control-decision-ordering-drift',
      'control-route-cross-splice',
      'control-delivery-alien-stage-receipt',
      'control-decision-missing-prior-event-ack',
      'control-cancel-missing-prior-event-ack',
      'control-decision-alien-prior-event-ack',
      'control-decision-sequence-gap',
      'control-decision-prior-time-inversion',
      'budget-rate-invalid',
      'budget-settle-receipt-hash-drift',
      'budget-settle-token-drift',
      'budget-settle-cost-drift',
      'budget-settle-call-drift',
      'budget-settle-disposition-drift',
      'resume-logical-attempt-active-reuse',
    ]);
    expect(golden.negative).toHaveLength(62);
    for (const item of golden.negative) {
      try {
        executeNegative(item.operation, item.input);
        throw new Error(`${item.id} unexpectedly succeeded.`);
      } catch (error) {
        expect(error, item.id).toBeInstanceOf(WorkflowRunnerAuthorityBindingContractError);
        expect(error, item.id).toMatchObject(item.expectedError);
      }
    }
  });

  it('parses exact canonical LF frames and rejects CR, double-LF, and drifted bytes', () => {
    const vectors = golden.positive.operations.checkpoint_commit;
    expect(
      parseWorkflowRunnerAuthorityBindingStageBytes(Buffer.from(vectors.stage.canonicalBytes)),
    ).toEqual(vectors.stage.value);
    expect(
      parseWorkflowRunnerAuthorityBindingResolutionBytes(
        Buffer.from(vectors.resolution.canonicalBytes),
      ),
    ).toEqual(vectors.resolution.value);
    expect(
      parseWorkflowRunnerAuthorityBindingReceiptBytes(
        Buffer.from(vectors.resolutionReceipt.canonicalBytes),
      ),
    ).toEqual(vectors.resolutionReceipt.value);
    for (const bytes of [
      `${vectors.stage.canonicalBytes}\n`,
      vectors.stage.canonicalBytes.replace(/\n$/u, '\r\n'),
      ` ${vectors.stage.canonicalBytes}`,
    ]) {
      expect(() => parseWorkflowRunnerAuthorityBindingStageBytes(Buffer.from(bytes))).toThrow(
        WorkflowRunnerAuthorityBindingContractError,
      );
    }
  });

  it('rejects ambiguous strict JSON and includes the terminal LF in frame limits', () => {
    const parse = parseWorkflowRunnerAuthorityBindingStageBytes;
    const invalidFrames = [
      Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]),
      Buffer.from('{"x":1,"x":2}\n'),
      Buffer.from('{"x":"\\ud800"}\n'),
      Buffer.from('{"x":9007199254740992}\n'),
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
    ];
    for (const frame of invalidFrames) {
      expect(() => parse(frame)).toThrowError(
        expect.objectContaining({
          code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
          path: '$',
        }),
      );
    }

    const longKey = '界'.repeat(
      Math.floor(WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxStringBytes / 3) + 1,
    );
    expect(() => parse(Buffer.from(`{"${longKey}":0}\n`))).toThrowError(
      expect.objectContaining({
        code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED',
        path: '$',
      }),
    );

    const frameLimit = WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxFrameBytes;
    const fixedBytes = Buffer.byteLength('{"x":["",""]}\n');
    const firstLength = WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxStringBytes;
    const secondLength = frameLimit - fixedBytes - firstLength;
    const exactLimit = Buffer.from(
      `{"x":["${'a'.repeat(firstLength)}","${'b'.repeat(secondLength)}"]}\n`,
    );
    expect(exactLimit).toHaveLength(frameLimit);
    expect(() => parse(exactLimit)).toThrowError(
      expect.objectContaining({
        code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_UNKNOWN_FIELD',
        path: '$/schema',
      }),
    );
    expect(() =>
      parse(Buffer.concat([exactLimit.subarray(0, -1), Buffer.from(' '), Buffer.from('\n')])),
    ).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED' }),
    );
  });

  it('keeps invalid timestamps, deterministic keys, and inert object rules on the frozen surface', () => {
    const stage = structuredClone(golden.positive.operations.checkpoint_commit.stage.value) as Json;
    stage.sentAt = '2026-13-01T00:00:00.000Z';
    expect(() => validateWorkflowRunnerAuthorityBindingStage(stage)).toThrowError(
      expect.objectContaining({
        code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
        path: '$/sentAt',
      }),
    );

    const unknowns = structuredClone(
      golden.positive.operations.checkpoint_commit.stage.value,
    ) as Json;
    unknowns.zzz = true;
    unknowns.aaa = true;
    expect(() => validateWorkflowRunnerAuthorityBindingStage(unknowns)).toThrowError(
      expect.objectContaining({
        code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_UNKNOWN_FIELD',
        path: '$/aaa',
      }),
    );

    const forbidden = structuredClone(
      golden.positive.operations.checkpoint_commit.resolution.value,
    ) as Json;
    Object.assign(asJson(forbidden.evidence, 'evidence'), { response: 'x', credentials: 'x' });
    expect(() => validateWorkflowRunnerAuthorityBindingResolution(forbidden)).toThrowError(
      expect.objectContaining({
        code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_FORBIDDEN_FIELD',
        path: '$/evidence/credentials',
      }),
    );

    const nullPrototype = Object.assign(
      Object.create(null) as Record<string, unknown>,
      golden.positive.operations.checkpoint_commit.stage.value,
    );
    expect(validateWorkflowRunnerAuthorityBindingStage(nullPrototype)).toEqual(
      golden.positive.operations.checkpoint_commit.stage.value,
    );
    expect(() => validateWorkflowRunnerAuthorityBindingStage(new Proxy(nullPrototype, {}))).toThrow(
      WorkflowRunnerAuthorityBindingContractError,
    );
  });

  it('maps budget charge overflow to binding errors before semantic drift checks', () => {
    const vectors = golden.positive.operations.budget_settle;
    const resolution = structuredClone(vectors.resolution.value) as Json;
    const evidence = asJson(resolution.evidence, 'evidence');
    const prepared = asJson(evidence.preparedRequest, 'preparedRequest');
    const request = JSON.parse(String(prepared.body)) as Json;
    request.rateNanoUsdPerToken = '1000000';
    const providerUsage = asJson(request.providerUsage, 'providerUsage');
    providerUsage.inputTokens = '9007199254740991';
    providerUsage.outputTokens = '0';
    providerUsage.totalTokens = '9007199254740991';
    const unsignedUsage = { ...providerUsage };
    delete unsignedUsage.receiptHash;
    providerUsage.receiptHash = `sha256:${createHash('sha256')
      .update('openslack.provider-usage-receipt.v1\0', 'utf8')
      .update(canonicalWorkflowBudgetAuthorityJson(unsignedUsage), 'utf8')
      .digest('hex')}`;
    request.usageReceiptHash = providerUsage.receiptHash;
    const nextPrepared = prepareWorkflowBudgetAuthorityRequest(
      'settle',
      request as unknown as WorkflowBudgetSettlementRequest,
      String(prepared.callerId),
    );
    evidence.preparedRequest = nextPrepared;
    evidence.rateNanoUsdPerToken = request.rateNanoUsdPerToken;
    evidence.providerUsageReceiptHash = providerUsage.receiptHash;
    asJson(evidence.sourceAuthority, 'sourceAuthority').requestHash = nextPrepared.requestHash;
    resolution.evidenceHash = hashWorkflowRunnerAuthorityBindingEvidence(evidence, 'budget_settle');
    expect(() =>
      validateWorkflowRunnerAuthorityBindingResolutionForStage(
        resolution,
        vectors.stage.value,
        vectors.stageReceipt.value,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
        path: '$/evidence/preparedRequest/body/nanoUsd',
      }),
    );
  });

  it('round-trips the closed error record through validate, prepare, parse, bytes, and hash', () => {
    const value = {
      schema: 'openslack.workflow_runner_authority_binding_error.v1',
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
      message: 'invalid frame',
      bindingId: null,
      operation: null,
      reconciliationToken: null,
    } as const;
    const validated = validateWorkflowRunnerAuthorityBindingError(value);
    const prepared = prepareWorkflowRunnerAuthorityBindingError(validated);
    expect(parseWorkflowRunnerAuthorityBindingErrorBytes(Buffer.from(prepared.body))).toEqual(
      validated,
    );
    expect(Buffer.byteLength(prepared.body)).toBeLessThanOrEqual(
      WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxErrorBytes,
    );
    expect(prepared.bodyHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('uses domain-separated hashes and never conflates stage, evidence, resolution, or receipt', () => {
    const vectors = golden.positive.operations.checkpoint_commit;
    const stage = validateWorkflowRunnerAuthorityBindingStage(vectors.stage.value);
    const resolution = validateWorkflowRunnerAuthorityBindingResolution(vectors.resolution.value);
    const receipt = validateWorkflowRunnerAuthorityBindingReceipt(vectors.resolutionReceipt.value);
    const hashes = new Set([
      hashWorkflowRunnerAuthorityBindingStage(stage),
      hashWorkflowRunnerAuthorityBindingEvidence(resolution.evidence, stage.operation),
      hashWorkflowRunnerAuthorityBindingResolution(resolution),
      hashWorkflowRunnerAuthorityBindingReceipt(receipt),
    ]);
    expect(hashes.size).toBe(4);
    const encodedObjects: object[] = [];
    const delivery = golden.positive.controlDelivery.accepted.checkpoint_commit;
    withWorkflowRunnerAuthorityBindingEncodingObserver(
      (value) => encodedObjects.push(value),
      () =>
        validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
          delivery.value,
          golden.positive.controlDelivery.messages.accepted.checkpoint_commit,
          vectors.stage.value,
          vectors.resolution.value,
          vectors.resolutionReceipt.value,
          vectors.stageReceipt.value,
          null,
        ),
    );
    expect(encodedObjects).toHaveLength(6);
    expect(new Set(encodedObjects).size).toBe(encodedObjects.length);
    expect(WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES).toEqual([
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_UNKNOWN_FIELD',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_HASH_MISMATCH',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_SEQUENCE_CONFLICT',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_REVISION_CONFLICT',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_RESUME_GENERATION_CONFLICT',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_REQUIRED',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_FORBIDDEN_FIELD',
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_RECONCILIATION_REQUIRED',
    ]);
  });

  it('parses each budget prepared request and durable receipt once per delivery validation', () => {
    const artifact = controlArtifact(golden.positive.controlDelivery.budgetAuthorization.reserved);
    const exchange = golden.positive.semanticVariants.budgetReserveGoAuthority;
    const events: string[] = [];
    const receipt = withWorkflowRunnerAuthorityBindingValidationObserver(
      (event) => events.push(event),
      () =>
        validateWorkflowRunnerAuthorityControlDeliveryReceiptWithContext(
          artifact.receipt.value,
          artifact.message,
          {
            stage: exchange.stage.value,
            resolution: exchange.resolution.value,
            resolutionReceipt: exchange.resolutionReceipt.value,
            stageReceipt: exchange.stageReceipt.value,
            priorEventDelivery: namedPriorDelivery(artifact.priorEventDeliveryRef),
            budgetSourceResult: artifact.budgetSourceResult,
          },
        ),
    );
    expect(receipt).toEqual(artifact.receipt.value);
    expect(events).toEqual(['budget_prepared_parse', 'budget_durable_parse']);
  });

  it('detects stale, extra, and missing artifacts in either generated mirror', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'openslack-binding-contract-'));
    const generator = resolve(root, 'scripts/workflow-runner-authority-binding-contracts/index.ts');
    const runGenerator = (command: '--generate' | '--check') =>
      spawnSync('bun', [generator, command], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          OPENSLACK_WORKFLOW_RUNNER_AUTHORITY_BINDING_OUTPUT_ROOT: outputRoot,
        },
      });
    const output = (result: ReturnType<typeof runGenerator>) =>
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    try {
      expect(runGenerator('--generate').status).toBe(0);
      expect(runGenerator('--check').status).toBe(0);

      const typescriptExtra = resolve(
        outputRoot,
        'packages/workflows/contracts/workflow-runner-authority-binding/v1/extra.json',
      );
      writeFileSync(typescriptExtra, '{}\n', 'utf8');
      const extraResult = runGenerator('--check');
      expect(extraResult.status).not.toBe(0);
      expect(output(extraResult)).toContain('Authority-binding typescript bundle inventory drift');
      unlinkSync(typescriptExtra);

      const goManifest = resolve(
        outputRoot,
        'services/workflow-control/runnerbindingcontract/generated/v1/manifest.json',
      );
      const goManifestBytes = readFileSync(goManifest);
      writeFileSync(goManifest, '{}\n', 'utf8');
      const staleResult = runGenerator('--check');
      expect(staleResult.status).not.toBe(0);
      expect(output(staleResult)).toContain('go:manifest.json');
      writeFileSync(goManifest, goManifestBytes);

      const goSchema = resolve(
        outputRoot,
        'services/workflow-control/runnerbindingcontract/generated/v1/schemas/workflow-runner-authority-binding-stage.v1.schema.json',
      );
      unlinkSync(goSchema);
      const missingResult = runGenerator('--check');
      expect(missingResult.status).not.toBe(0);
      expect(output(missingResult)).toContain('Authority-binding go bundle inventory drift');
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
