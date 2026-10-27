import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertHarnessRunStartEligibility, bindHarnessRunStartEligibility, bindHarnessToolEligibility,
  createHarnessTaskEligibility, harnessRunStartEligibilityRestriction } from '../harness-eligibility.js';

const taskBinding = { taskId: 'TASK-START', taskHash: 'a'.repeat(64), principalId: 'principal:fixture', principalHash: 'b'.repeat(64), phase: 'execute' as const };
const runBinding = { runId: 'RUN-START', generation: 'generation-one' };
const expected = { ...runBinding, requestHash: taskBinding.taskHash, principalHash: taskBinding.principalHash };
afterEach(() => vi.restoreAllMocks());

describe('nominal startup lease restrictions (explicit synthetic authority observations only)', () => {
  it('derives an exact run-bound restriction without exposing a capability or accepting a serialized copy', () => {
    const task = createHarnessTaskEligibility(taskBinding, { mode: 'not_applicable' });
    const fact = bindHarnessRunStartEligibility(task, runBinding);
    expect(() => assertHarnessRunStartEligibility(fact, expected)).not.toThrow();
    expect(harnessRunStartEligibilityRestriction(fact)).toEqual({ mode: 'not_applicable' });
    expect(Object.keys(fact)).toEqual([]);
    expect(() => assertHarnessRunStartEligibility(JSON.parse(JSON.stringify(fact)), expected)).toThrow('eligibility');
  });

  it.each(['runId', 'requestHash', 'principalHash', 'generation'] as const)('rejects a mismatched %s binding', key => {
    const fact = bindHarnessRunStartEligibility(createHarnessTaskEligibility(taskBinding, { mode: 'not_applicable' }), runBinding);
    expect(() => assertHarnessRunStartEligibility(fact, { ...expected, [key]: `${expected[key]}-other` })).toThrow('eligibility');
  });

  it.each([undefined, {}, { mode: 'not_applicable' }, { mode: 'required', expiresAt: Infinity }])('rejects absent or forged startup observations', value => {
    expect(() => assertHarnessRunStartEligibility(value, expected)).toThrow('eligibility');
    expect(() => harnessRunStartEligibilityRestriction(value)).toThrow('eligibility');
  });

  it('preserves a required lease cutoff instead of converting it to unlimited eligibility', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const task = createHarnessTaskEligibility(taskBinding, { mode: 'required', expiresAt: 1100 });
    const fact = bindHarnessRunStartEligibility(task, runBinding);
    expect(harnessRunStartEligibilityRestriction(fact)).toEqual({ mode: 'required', expiresAt: 1100 });
    clock.mockReturnValue(1100);
    expect(() => assertHarnessRunStartEligibility(fact, expected)).toThrow('eligibility');
    expect(() => harnessRunStartEligibilityRestriction(fact)).toThrow('eligibility');
  });

  it('does not reuse task/report or native tool observations as startup authority', () => {
    const execute = createHarnessTaskEligibility(taskBinding, { mode: 'not_applicable' });
    const report = createHarnessTaskEligibility({ ...taskBinding, phase: 'report' }, { mode: 'not_applicable' });
    const tool = bindHarnessToolEligibility(execute, { ...runBinding, toolName: 'Read', targetPath: '/fixture.txt' });
    expect(() => bindHarnessRunStartEligibility(report, runBinding)).toThrow('eligibility');
    expect(() => assertHarnessRunStartEligibility(execute, expected)).toThrow('eligibility');
    expect(() => assertHarnessRunStartEligibility(tool, expected)).toThrow('eligibility');
  });
});
