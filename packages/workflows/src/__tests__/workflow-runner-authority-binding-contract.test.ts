import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_RECEIPT_SCHEMAS,
  WorkflowRunnerAuthorityBindingContractError,
  hashWorkflowRunnerAuthorityBindingEvidence,
  hashWorkflowRunnerAuthorityBindingReceipt,
  hashWorkflowRunnerAuthorityBindingResolution,
  hashWorkflowRunnerAuthorityBindingStage,
  parseWorkflowRunnerAuthorityBindingReceiptBytes,
  parseWorkflowRunnerAuthorityBindingResolutionBytes,
  parseWorkflowRunnerAuthorityBindingStageBytes,
  prepareWorkflowRunnerAuthorityBindingReceipt,
  prepareWorkflowRunnerAuthorityBindingResolution,
  prepareWorkflowRunnerAuthorityBindingStage,
  validateWorkflowRunnerAuthorityBindingReceipt,
  validateWorkflowRunnerAuthorityBindingResolution,
  validateWorkflowRunnerAuthorityBindingResolutionForStage,
  validateWorkflowRunnerAuthorityBindingResolutionReceipt,
  validateWorkflowRunnerAuthorityBindingStage,
  validateWorkflowRunnerAuthorityBindingStageReceipt,
  validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage,
  workflowRunnerAuthorityBindingExpectedKind,
  workflowRunnerAuthorityBindingRunnerDelta,
  type WorkflowRunnerAuthorityBindingOperation,
} from '../workflow-runner-authority-binding-contract.js';

const root = resolve('.');
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

interface Golden {
  readonly sourceLocks: Record<string, string>;
  readonly operationMatrix: Array<{
    operation: WorkflowRunnerAuthorityBindingOperation;
    targetKind: string;
    runnerDelta: { revision: number; generation: number };
    sourceEvidenceState: 'prepared' | 'committed';
    sourceRevisionDelta: number;
    sourceGenerationDelta: number;
    sourceReceiptSchema: string | null;
  }>;
  readonly positive: {
    readonly operations: Record<WorkflowRunnerAuthorityBindingOperation, ExchangeVectors>;
    readonly semanticVariants: Record<string, ExchangeVectors>;
    readonly controlDelivery: {
      readonly accepted: Record<WorkflowRunnerAuthorityBindingOperation, ExactVector>;
      readonly reconciliationRequired: ExactVector;
      readonly byKind: Record<
        | 'event_receipt'
        | 'budget_authorization'
        | 'effect_authorization'
        | 'resume_offer'
        | 'cancel_request',
        {
          readonly operation: WorkflowRunnerAuthorityBindingOperation;
          readonly message: unknown;
          readonly receipt: ExactVector;
        }
      >;
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
      );
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
    expect(manifest.authorityBoundary).toMatchObject({
      contractOnly: true,
      qualificationOnly: true,
      authorityClaim: 'NO_AUTHORITY',
      runtimeCompositionImplemented: false,
      productionRoutingActivated: false,
      frozenAuthorityV2KindsExtended: false,
      frozenAuthorityV2KindCount: 18,
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
    expect(golden.operationMatrix).toEqual([
      {
        operation: 'checkpoint_commit',
        targetKind: 'checkpoint_commit',
        runnerDelta: { revision: 1, generation: 0 },
        sourceEvidenceState: 'committed',
        sourceRevisionDelta: 1,
        sourceGenerationDelta: 0,
        sourceReceiptSchema: 'openslack.workflow_runner_checkpoint_authority_receipt.v1',
      },
      {
        operation: 'effect_authorize',
        targetKind: 'effect_intent',
        runnerDelta: { revision: 1, generation: 0 },
        sourceEvidenceState: 'committed',
        sourceRevisionDelta: 1,
        sourceGenerationDelta: 0,
        sourceReceiptSchema: 'openslack.workflow_runner_effect_authority_receipt.v1',
      },
      {
        operation: 'effect_complete',
        targetKind: 'effect_outcome',
        runnerDelta: { revision: 0, generation: 0 },
        sourceEvidenceState: 'committed',
        sourceRevisionDelta: 1,
        sourceGenerationDelta: 0,
        sourceReceiptSchema: 'openslack.workflow_runner_effect_completion_receipt.v1',
      },
      {
        operation: 'budget_reserve',
        targetKind: 'budget_reserve_request',
        runnerDelta: { revision: 1, generation: 0 },
        sourceEvidenceState: 'prepared',
        sourceRevisionDelta: 0,
        sourceGenerationDelta: 0,
        sourceReceiptSchema: null,
      },
      {
        operation: 'budget_settle',
        targetKind: 'budget_usage_report',
        runnerDelta: { revision: 1, generation: 0 },
        sourceEvidenceState: 'prepared',
        sourceRevisionDelta: 0,
        sourceGenerationDelta: 0,
        sourceReceiptSchema: null,
      },
      {
        operation: 'resume_advance',
        targetKind: 'lease_accept',
        runnerDelta: { revision: 1, generation: 1 },
        sourceEvidenceState: 'committed',
        sourceRevisionDelta: 1,
        sourceGenerationDelta: 1,
        sourceReceiptSchema: 'openslack.workflow_runner_resume_authority_receipt.v1',
      },
    ]);
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
    for (const [kind, item] of Object.entries(deliveries.byKind)) {
      const exchange = golden.positive.operations[item.operation];
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
            : {
                message: deliveries.messages.accepted[item.operation],
                receipt: deliveries.accepted[item.operation].value,
              },
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
    const cancel = deliveries.byKind.cancel_request;
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
    for (const item of Object.values(golden.positive.controlDelivery.byKind)) {
      const validator = ajv.getSchema(ids.receipt)!;
      expect(validator(item.receipt.value), ajv.errorsText(validator.errors)).toBe(true);
    }
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
      golden.positive.controlDelivery.byKind.event_receipt.receipt.value,
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
      'budget-nested-contract-error',
      'effect-approved-expiry-boundary',
      'effect-expired-future-boundary',
      'effect-rejected-expiry-boundary',
      'control-event-receipt-target-drift',
      'control-decision-budget-evidence-drift',
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
      'resume-logical-attempt-active-reuse',
    ]);
    expect(golden.negative).toHaveLength(37);
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
    expect(WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES).toHaveLength(15);
  });
});
