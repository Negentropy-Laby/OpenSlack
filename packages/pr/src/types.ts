import type { RiskZone } from '@openslack/kernel';

export type PRReviewState =
  | 'DISCOVERED'
  | 'CLASSIFIED'
  | 'ANALYZED'
  | 'CHECKS_PENDING'
  | 'CHECKS_FAILED'
  | 'NEEDS_HUMAN_APPROVAL'
  | 'NEEDS_CODEOWNER_APPROVAL'
  | 'NEEDS_CHANGES'
  | 'BLOCKED_POLICY'
  | 'BLOCKED_SELF_REVIEW'
  | 'BLOCKED_BLACK_ZONE'
  | 'BLOCKED_DRAFT'
  | 'BLOCKED_AUTHORIZATION'
  | 'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER'
  | 'BLOCKED_SINGLE_MAINTAINER'
  | 'BLOCKED_WORKFLOW_GATE'
  | 'BLOCKED_PROFILE_SYNC_GATE'
  | 'BOT_APPROVAL_IGNORED'
  | 'HUMAN_APPROVED'
  | 'READY_TO_MERGE'
  | 'MERGED';

export interface WorkflowGateCriterion {
  name: string;
  status: 'PASS' | 'FAIL' | 'N/A';
  detail?: string;
}

export interface WorkflowGateResult {
  touchedWorkflowFiles: boolean;
  overall: 'PASS' | 'FAIL' | 'N/A';
  criteria: WorkflowGateCriterion[];
}

export interface ProfileSyncGateCriterion {
  name: string;
  status: 'PASS' | 'FAIL' | 'N/A';
  detail?: string;
}

export interface ProfileSyncGateResult {
  touchedProfileSyncFiles: boolean;
  overall: 'PASS' | 'FAIL' | 'N/A';
  criteria: ProfileSyncGateCriterion[];
}

export interface PRReviewReport {
  prNumber: number;
  title: string;
  author: string;
  state: string;
  draft: boolean;
  baseRef: string;
  riskZone: RiskZone;
  changedFiles: string[];
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
  reviews: Array<{ user: string; state: string }>;
  humanApprovals: Array<{ user: string }>;
  decision: PRReviewState;
  reason: string;
  recommendation: string;
  mergeable: boolean;
  body?: string;
  headRef?: string;
  workflowGate?: WorkflowGateResult;
  profileSyncGate?: ProfileSyncGateResult;
}

export interface PRReviewPolicy {
  no_auto_approval: boolean;
  no_self_review: boolean;
  red_zone_human_required: boolean;
  black_zone_never_merge: boolean;
}
