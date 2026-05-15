import { classifyPaths } from '@openslack/policy';
import type { RiskZone } from '@openslack/policy';

export interface PRClassification {
  riskZone: RiskZone;
  humanApprovalRequired: boolean;
  autoMergeAllowed: boolean;
  requiredChecks: string[];
  requiredAgentReviews: number;
}

export function classifySelfEvolutionPR(changedPaths: string[]): PRClassification {
  const riskZone = classifyPaths(changedPaths);

  switch (riskZone) {
    case 'black':
      return {
        riskZone: 'black',
        humanApprovalRequired: false, // denied, not approval-based
        autoMergeAllowed: false,
        requiredChecks: [],
        requiredAgentReviews: 0,
      };
    case 'red':
      return {
        riskZone: 'red',
        humanApprovalRequired: true,
        autoMergeAllowed: false,
        requiredChecks: ['workspace-validate', 'typecheck', 'unit-tests', 'self-eval', 'security-scan', 'policy-audit'],
        requiredAgentReviews: 2,
      };
    case 'yellow':
      return {
        riskZone: 'yellow',
        humanApprovalRequired: false,
        autoMergeAllowed: false,
        requiredChecks: ['workspace-validate', 'typecheck', 'unit-tests', 'integration-tests', 'self-eval', 'security-scan'],
        requiredAgentReviews: 2,
      };
    case 'green':
      return {
        riskZone: 'green',
        humanApprovalRequired: false,
        autoMergeAllowed: true,
        requiredChecks: ['workspace-validate', 'self-eval', 'security-scan'],
        requiredAgentReviews: 1,
      };
  }
}
