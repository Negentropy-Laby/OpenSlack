import { readFileSync } from 'node:fs';
import { parseWorkflowRunRecoveryEvidence } from '../workflow-run-recovery-evidence.js';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import {
  parseWorkflowBindingReconciliation,
  parseWorkflowBindingSettlement,
} from '../workflow-binding-reconciliation-contract.js';

const base = new URL('../../contracts/workflow-recovery/v2/', import.meta.url);
const schemas = JSON.parse(readFileSync(new URL('schemas.json', base), 'utf8'));
const vectors = JSON.parse(readFileSync(new URL('golden-vectors.json', base), 'utf8')) as {
  schema: string;
  name: string;
  bytes: string;
  valid: boolean;
}[];
const ajv = new Ajv2020({ strict: false });
ajv.addFormat('date-time', fullFormats['date-time']!);
describe('recovery wire differential vectors', () => {
  for (const vector of vectors)
    it(`${vector.schema}: ${vector.name}`, () => {
      const validate = ajv.compile(schemas[vector.schema]);
      expect(validate(JSON.parse(vector.bytes))).toBe(vector.valid);
      const parse =
        vector.schema === 'BindingReconciliationRequest'
          ? parseWorkflowBindingReconciliation
          : parseWorkflowBindingSettlement;
      if (vector.valid) expect(() => parse(vector.bytes)).not.toThrow();
      else expect(() => parse(vector.bytes)).toThrow();
    });
});

const v3Base = new URL('../../contracts/workflow-recovery/v3/', import.meta.url);
const v3Schema = JSON.parse(
  readFileSync(new URL('schemas.json', v3Base), 'utf8'),
).RecoveryEvidenceV3;
const v3Vectors = JSON.parse(
  readFileSync(new URL('golden-vectors.json', v3Base), 'utf8'),
) as typeof vectors;
describe('v3 recovery read point differential vectors', () => {
  for (const vector of v3Vectors)
    it(vector.name, () => {
      expect(ajv.compile(v3Schema)(JSON.parse(vector.bytes))).toBe(vector.valid);
      const parse = () =>
        parseWorkflowRunRecoveryEvidence(vector.bytes, 'workspace.test', 'run.test');
      if (vector.valid) expect(parse().recoveryVersion).toBe('9007199254740993');
      else expect(parse).toThrow();
    });
});
