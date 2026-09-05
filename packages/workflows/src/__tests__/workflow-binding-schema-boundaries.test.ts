import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES,
  validateWorkflowRunnerAuthorityBindingError,
  validateWorkflowRunnerAuthorityBindingReceipt,
  validateWorkflowRunnerAuthorityBindingResolution,
  validateWorkflowRunnerAuthorityBindingStage,
} from '../workflow-runner-authority-binding-contract.js';
import {
  prepareWorkflowRunnerV2RuntimeAdmission,
  validateWorkflowRunnerV2RuntimeAdmission,
  validateWorkflowRunnerV2RuntimeAdmissionReceipt,
} from '../workflow-runner-runtime-admission-contract.js';
import { WORKFLOW_RUNNER_AUTHORITY_BINDING_SCHEMA_FORMATS } from '../workflow-runner-authority-binding-schema.js';

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
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addFormat('date-time', fullFormats['date-time']);
for (const [name, format] of Object.entries(WORKFLOW_RUNNER_AUTHORITY_BINDING_SCHEMA_FORMATS))
  ajv.addFormat(name, format);
for (const path of readdirSync(resolve(root, 'v1/schemas')))
  ajv.addSchema(JSON.parse(readFileSync(resolve(root, 'v1/schemas', path), 'utf8')));
const cases: Array<{
  id: string;
  kind: string;
  accepted: boolean;
  set: Record<string, unknown>;
  remove: string[];
}> = JSON.parse(readFileSync(resolve(root, 'schema-boundaries.json'), 'utf8'));

describe('shared authority-binding schema boundary corpus', () => {
  it.each(cases)('$id agrees between TypeScript and the schema', (item) => {
    const base = bases[item.kind];
    const validate = validators[item.kind];
    if (!base || !validate) throw new Error('Unknown boundary fixture kind.');
    const value = structuredClone(base);
    const parent = (path: string) => {
      const keys = path.slice(1).split('/');
      const key = keys.pop();
      if (!key) throw new Error('Missing fixture field.');
      let record = value;
      for (const part of keys) record = record[part] as Record<string, unknown>;
      return { record, key };
    };
    for (const [path, change] of Object.entries(item.set)) {
      const { record, key } = parent(path);
      record[key] = change;
    }
    for (const path of item.remove) {
      const { record, key } = parent(path);
      delete record[key];
    }
    let accepted = false;
    try {
      validate(value);
      accepted = true;
    } catch {
      /* rejection is part of the corpus */
    }
    expect(accepted, `${item.id}: TypeScript`).toBe(item.accepted);
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
    for (const [key, value] of [
      ['newId', null],
      ['newHash', 'a'.repeat(64)],
      ['newAt', '2026-08-20T00:00:00.000Z'],
    ] as const) {
      expect(() => authorityBindingFieldSchema(value, [key])).toThrow('No explicit');
    }
  });
});
