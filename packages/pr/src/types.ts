import type { RiskZone } from '@openslack/kernel';

export type PRReviewState =
  | 'DISCOVERED'
  | 'CLASSIFIED'
  | 'ANALYZED'
  | 'CHECKS_PENDING'
  | 'CHECKS_FAILED'
  | 'NEEDS_HUMAN_APPROVAL'
  | 'NEEDS_CHANGES'
  | 'BLOCKED_POLICY'
  | 'BLOCKED_SELF_REVIEW'
  | 'BLOCKED_BLACK_ZONE'
  | 'HUMAN_APPROVED'
  | 'READY_TO_MERGE'
  | 'MERGED';

export interface PRReviewReport {
  prNumber: number;
  title: string;
  author: string;
  riskZone: RiskZone;
  changedFiles: string[];
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
  reviews: Array<{ user: string; state: string }>;
  humanApprovals: Array<{ user: string }>;
  decision: PRReviewState;
  reason: string;
  recommendation: string;
  mergeable: boolean;
}

export interface PRReviewPolicy {
  no_auto_approval: boolean;
  no_self_review: boolean;
  red_zone_human_required: boolean;
  black_zone_never_merge: boolean;
}
