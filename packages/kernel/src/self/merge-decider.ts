import type { MergeDecision, SelfValidationResult } from '../types.js';
import type { RiskZone } from '../types.js';

export interface MergeInput {
  riskZone: RiskZone;
  validation: SelfValidationResult | null;
  reviews: ReviewResult[];
  humanApproval?: { approved: boolean; by: string };
}

export interface ReviewResult {
  reviewerAgent: string;
  implementationAgent: string;
  decision: 'approve' | 'reject' | 'needs_changes';
  comments: string;
}

export function decideMerge(input: MergeInput): MergeDecision {
  if (input.riskZone === 'black') {
    return { decision: 'deny', reason: 'Black Zone files touched — PR rejected automatically', riskZone: 'black' };
  }

  if (!input.validation || input.validation.decision === 'fail') {
    return { decision: 'deny', reason: 'Validation failed — see self_validation.yaml', riskZone: input.riskZone };
  }

  if (input.riskZone === 'red' && !input.humanApproval) {
    return { decision: 'require_human', reason: 'Red Zone requires human approval', riskZone: 'red' };
  }

  // Check independent review — implementation agent != review agent
  const selfReviewed = input.reviews.some(
    (r) => r.reviewerAgent === r.implementationAgent,
  );
  if (selfReviewed) {
    return { decision: 'wait', reason: 'Implementation agent cannot review own PR', riskZone: input.riskZone };
  }

  const hasRequiredReviews = input.reviews.filter((r) => r.decision === 'approve').length > 0;
  if (!hasRequiredReviews && input.riskZone !== 'green') {
    return { decision: 'wait', reason: 'Independent agent review required', riskZone: input.riskZone };
  }

  return { decision: 'merge_queue', reason: 'All gates passed — eligible for merge queue', riskZone: input.riskZone };
}
