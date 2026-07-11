import { describe, it, expect } from 'vitest';
import { classifySelfEvolutionPR } from '../classify-pr.js';

describe('classifySelfEvolutionPR', () => {
  it('returns green for docs paths', () => {
    const result = classifySelfEvolutionPR(['docs/readme.md']);
    expect(result.riskZone).toBe('green');
    expect(result.autoMergeAllowed).toBe(true);
    expect(result.humanApprovalRequired).toBe(false);
    expect(result.requiredAgentReviews).toBe(1);
  });

  it('returns yellow for core package paths', () => {
    const result = classifySelfEvolutionPR(['packages/core/src/claim-broker.ts']);
    expect(result.riskZone).toBe('yellow');
    expect(result.autoMergeAllowed).toBe(false);
    expect(result.humanApprovalRequired).toBe(false);
    expect(result.requiredAgentReviews).toBe(2);
  });

  it('fails unmatched paths safe to yellow without auto-merge', () => {
    const result = classifySelfEvolutionPR(['new-root-config.yaml']);
    expect(result.riskZone).toBe('yellow');
    expect(result.autoMergeAllowed).toBe(false);
    expect(result.humanApprovalRequired).toBe(false);
    expect(result.requiredAgentReviews).toBe(2);
  });

  it('returns red for GitHub workflow paths', () => {
    const result = classifySelfEvolutionPR(['.github/workflows/test.yml']);
    expect(result.riskZone).toBe('red');
    expect(result.autoMergeAllowed).toBe(false);
    expect(result.humanApprovalRequired).toBe(true);
    expect(result.requiredAgentReviews).toBe(2);
  });

  it('returns black for secret files', () => {
    const result = classifySelfEvolutionPR(['secrets/prod.key']);
    expect(result.riskZone).toBe('black');
    expect(result.autoMergeAllowed).toBe(false);
    expect(result.humanApprovalRequired).toBe(false);
  });

  it('returns red for constitution changes', () => {
    const result = classifySelfEvolutionPR(['.openslack/self/constitution.md']);
    expect(result.riskZone).toBe('red');
    expect(result.humanApprovalRequired).toBe(true);
  });

  it('returns red for kernel source changes', () => {
    const result = classifySelfEvolutionPR(['packages/kernel/src/zones.ts']);
    expect(result.riskZone).toBe('red');
    expect(result.humanApprovalRequired).toBe(true);
  });

  it('returns most restrictive zone for mixed paths', () => {
    const result = classifySelfEvolutionPR(['docs/readme.md', '.github/workflows/test.yml']);
    expect(result.riskZone).toBe('red');
  });
});
