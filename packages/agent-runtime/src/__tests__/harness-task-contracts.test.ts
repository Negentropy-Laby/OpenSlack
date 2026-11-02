import { describe, expect, it } from 'vitest';
import { assertHarnessTaskReport, assertHarnessExecutionBinding } from '../harness-task-contracts.js';

describe('report and cumulative Harness evidence bounds', () => {
  it.each([0, 32, 33, 128, 129])('retains independent report and state limits at %s references', count => {
    const refs = Array.from({ length: count }, (_, index) => `artifact:fixture-${index}`);
    const report = { runId: 'RUN-FIXTURE', reportId: 'fixture', summary: 'fixture', evidenceRefs: refs };
    const state = { schema: 'openslack.harness_execution.v1', taskId: 'TASK-1', summary: 'fixture', acceptance: 'pending', evidenceRefs: refs };
    const original = JSON.stringify({ report, state });
    if (count <= 32) expect(() => assertHarnessTaskReport(report)).not.toThrow();
    else expect(() => assertHarnessTaskReport(report)).toThrow();
    if (count <= 128) expect(() => assertHarnessExecutionBinding(state, 'running')).not.toThrow();
    else expect(() => assertHarnessExecutionBinding(state, 'running')).toThrow();
    expect(JSON.stringify({ report, state })).toBe(original);
  });
  it('requires verified acceptance for a completed state', () => {
    const binding = { schema: 'openslack.harness_execution.v1', taskId: 'TASK-1', summary: 'fixture', acceptance: 'pending', evidenceRefs: [] };
    expect(() => assertHarnessExecutionBinding(binding, 'completed')).toThrow();
    expect(() => assertHarnessExecutionBinding({ ...binding, acceptance: 'verified' }, 'completed')).not.toThrow();
  });
});
