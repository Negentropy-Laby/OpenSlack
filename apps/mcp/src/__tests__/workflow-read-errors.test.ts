import { describe, expect, it } from 'vitest';
import { WorkflowRunReadError } from '@openslack/workflows';
import { safeToolError } from '../errors.js';

describe('workflow evidence protocol diagnostics', () => {
  it('preserves typed input and reconciliation failures without exposing internal exceptions', () => {
    for (const code of [
      'WORKFLOW_RUN_PROJECTION_ID_INVALID',
      'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED',
    ] as const) {
      const error = safeToolError(
        new WorkflowRunReadError([{ scope: 'run', runId: 'run.test', code }]),
      );
      expect(error.safeCode).toBe(code);
      expect(error.safeStatus).toBe(code.includes('RECONCILIATION') ? 'blocked' : 'failed');
    }
    expect(safeToolError(new Error('sensitive internal detail')).message).not.toContain(
      'sensitive internal detail',
    );
  });
});
