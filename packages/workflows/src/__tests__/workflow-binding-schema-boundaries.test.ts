import { applyBindingCorpus } from './helpers/binding-corpus.js';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES,
  WorkflowRunnerAuthorityBindingContractError,
  validateWorkflowRunnerAuthorityBindingError,
  validateWorkflowRunnerAuthorityBindingReceipt,
  validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage,
  validateWorkflowRunnerAuthorityBindingResolution,
  validateWorkflowRunnerAuthorityBindingStage,
} from '../workflow-runner-authority-binding-contract.js';
import {
  WorkflowRunnerV2RuntimeAdmissionError,
  prepareWorkflowRunnerV2RuntimeAdmission,
  validateWorkflowRunnerV2RuntimeAdmission,
  validateWorkflowRunnerV2RuntimeAdmissionReceipt,
} from '../workflow-runner-runtime-admission-contract.js';
import { registerWorkflowRunnerAuthorityBindingSchemaFormats } from '../workflow-runner-authority-binding-schema.js';

const root = fileURLToPath(
  new URL('../../contracts/workflow-runner-authority-binding/', import.meta.url),
);
const golden = JSON.parse(readFileSync(resolve(root, 'v1/golden-vectors.json'), 'utf8'));
const exchange = golden.positive.operations.resume_advance;
const bases: Record<string, Record<string, unknown>> = {
  error: {
    schema: 'openslack.workflow_runner_authority_binding_error.v1',
    code: WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES[0],
    message: 'closed contract failure',
    bindingId: null,
    operation: null,
    reconciliationToken: null,
  },
  receipt: exchange.stageReceipt.value,
  stage: exchange.stage.value,
  resolution: exchange.resolution.value,
  runtimeAdmission: golden.positive.runtimeAdmission.request.value,
  runtimeAdmissionReceipt: golden.positive.runtimeAdmission.receipt.value,
};
const prepared = prepareWorkflowRunnerV2RuntimeAdmission(
  validateWorkflowRunnerV2RuntimeAdmission(bases.runtimeAdmission),
);
const validators: Record<string, (value: unknown) => unknown> = {
  error: validateWorkflowRunnerAuthorityBindingError,
  receipt: validateWorkflowRunnerAuthorityBindingReceipt,
  stage: validateWorkflowRunnerAuthorityBindingStage,
  resolution: validateWorkflowRunnerAuthorityBindingResolution,
  runtimeAdmission: validateWorkflowRunnerV2RuntimeAdmission,
  runtimeAdmissionReceipt: (value) =>
    validateWorkflowRunnerV2RuntimeAdmissionReceipt(value, prepared),
};
const schemaNames: Record<string, string> = {
  error: 'workflow-runner-authority-binding-error',
  receipt: 'workflow-runner-authority-binding-receipt',
  stage: 'workflow-runner-authority-binding-stage',
  resolution: 'workflow-runner-authority-binding-resolution',
  runtimeAdmission: 'workflow-runner-v2-runtime-admission',
  runtimeAdmissionReceipt: 'workflow-runner-v2-runtime-admission-receipt',
};
const contextualValidators: Record<string, (value: unknown) => unknown> = {};
function boundaryContext(fixture: typeof golden, kind: string) {
  const ref = fixture.positive.controlDelivery.byKind[kind];
  const artifact = fixture.positive.controlDelivery.artifacts[ref];
  if (!artifact) throw new Error('Missing boundary control artifact.');
  const context =
    kind === 'budget_authorization'
      ? fixture.positive.semanticVariants.budgetReserveGoAuthority
      : fixture.positive.operations[artifact.operation];
  if (
    !context ||
    !context.stage ||
    !context.stageReceipt ||
    !context.resolution ||
    !context.resolutionReceipt
  )
    throw new Error('Missing boundary operation context.');
  const prior = artifact.priorEventDeliveryRef
    ? fixture.positive.controlDelivery.priorEventDeliveries[artifact.priorEventDeliveryRef]
    : null;
  if (artifact.priorEventDeliveryRef && !prior) throw new Error('Missing boundary prior delivery.');
  if (
    !artifact.priorEventDeliveryRef &&
    kind !== 'event_receipt' &&
    (!fixture.positive.controlDelivery.messages.accepted[artifact.operation] ||
      !fixture.positive.controlDelivery.accepted[artifact.operation])
  )
    throw new Error('Missing boundary accepted prior delivery.');
  return { artifact, context, prior };
}

function expectedContractRejection(error: unknown, kind: string): boolean {
  const expected = kind.startsWith('runtimeAdmission')
    ? error instanceof WorkflowRunnerV2RuntimeAdmissionError
    : error instanceof WorkflowRunnerAuthorityBindingContractError;
  if (!expected) throw error;
  return false;
}

for (const kind of Object.keys(golden.positive.controlDelivery.byKind)) {
  const { artifact, context, prior } = boundaryContext(golden, kind);
  const key = 'control:' + kind;
  bases[key] = artifact.receipt.value;
  validators[key] = validateWorkflowRunnerAuthorityBindingReceipt;
  schemaNames[key] = 'workflow-runner-authority-binding-receipt';
  contextualValidators[key] = (value) =>
    validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(value, artifact.message, {
      stage: context.stage.value,
      stageReceipt: context.stageReceipt.value,
      resolution: context.resolution.value,
      resolutionReceipt: context.resolutionReceipt.value,
      priorEventDelivery: prior
        ? { message: prior.message, receipt: prior.receipt.value }
        : kind === 'event_receipt'
          ? null
          : {
              message: golden.positive.controlDelivery.messages.accepted[artifact.operation],
              receipt: golden.positive.controlDelivery.accepted[artifact.operation].value,
            },
      budgetSourceResult: artifact.budgetSourceResult,
    });
}
const ajv = new Ajv2020({ strict: true, allErrors: true });
registerWorkflowRunnerAuthorityBindingSchemaFormats(ajv);
for (const path of readdirSync(resolve(root, 'v1/schemas')))
  ajv.addSchema(JSON.parse(readFileSync(resolve(root, 'v1/schemas', path), 'utf8')));
const cases: Array<{
  id: string;
  kind: string;
  accepted: boolean;
  expectedError?: { code: string; path: string; message: string };
  set: Record<string, unknown>;
  remove: string[];
}> = JSON.parse(readFileSync(resolve(root, 'schema-boundaries.json'), 'utf8'));

describe('shared authority-binding schema boundary corpus', () => {
  it('exposes broken fixture wiring and unexpected exceptions', () => {
    for (const fault of ['operation', 'artifact', 'prior', 'kind']) {
      const fixture = structuredClone(golden);
      const kind = fault === 'kind' ? 'unknown' : 'effect_authorization';
      const reference = fixture.positive.controlDelivery.byKind.effect_authorization;
      const artifact = fixture.positive.controlDelivery.artifacts[reference];
      if (fault === 'operation') delete fixture.positive.operations[artifact.operation];
      if (fault === 'artifact') delete fixture.positive.controlDelivery.artifacts[reference];
      if (fault === 'prior') artifact.priorEventDeliveryRef = 'missing';
      expect(() => boundaryContext(fixture, kind)).toThrow();
    }
    const wiring = new TypeError('broken fixture');
    expect(() => expectedContractRejection(wiring, 'control:effect_authorization')).toThrow(wiring);
    expect(() => expectedContractRejection(wiring, 'runtimeAdmission')).toThrow(wiring);
  });

  it.each(cases)('$id agrees between TypeScript and the schema', (item) => {
    const base = bases[item.kind];
    const validate = validators[item.kind];
    if (!base || !validate) throw new Error('Unknown boundary fixture kind.');
    const value = structuredClone(base);
    applyBindingCorpus(value, item.set, item.remove);
    let accepted = false;
    try {
      validate(value);
      accepted = true;
    } catch (error) {
      accepted = expectedContractRejection(error, item.kind);
      if (item.expectedError) expect(error).toMatchObject(item.expectedError);
    }
    expect(accepted, `${item.id}: TypeScript`).toBe(item.accepted);
    if (contextualValidators[item.kind]) {
      let contextual = false;
      try {
        contextualValidators[item.kind]!(value);
        contextual = true;
      } catch (error) {
        contextual = expectedContractRejection(error, item.kind);
        if (item.expectedError) expect(error).toMatchObject(item.expectedError);
      }
      expect(contextual, item.id + ': contextual TypeScript').toBe(item.accepted);
    }
    const schema = ajv.getSchema(
      `https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/${schemaNames[item.kind]}.v1.schema.json`,
    );
    if (!schema) throw new Error('Boundary schema is missing.');
    expect(schema(value), `${item.id}: ${ajv.errorsText(schema.errors)}`).toBe(item.accepted);
  });

  it('requires explicit rules for new field names rather than inferring from suffix or sample', async () => {
    const script = fileURLToPath(
      new URL(
        '../../../../scripts/workflow-runner-authority-binding-contracts/schema-fields.ts',
        import.meta.url,
      ),
    );
    const { authorityBindingFieldSchema } = await import(/* @vite-ignore */ script);
    for (const path of [
      ['evidence', 'idempotencyKey'],
      ['unknown', 'target', 'idempotencyKey'],
      ['unknown', 'preparedRequest', 'idempotencyKey'],
    ]) {
      expect(() =>
        authorityBindingFieldSchema(
          'openslack.workflow-control-authority.v2.' + 'a'.repeat(64),
          path,
        ),
      ).toThrow('No explicit');
    }
    for (const [key, value] of [
      ['newId', null],
      ['newHash', 'a'.repeat(64)],
      ['newAt', '2026-08-20T00:00:00.000Z'],
    ] as const) {
      expect(() => authorityBindingFieldSchema(value, [key])).toThrow('No explicit');
    }
  });
});
