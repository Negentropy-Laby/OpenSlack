import type { AgentPermissionSnapshot, AgentPrincipal } from '@openslack/kernel';
import type { GitHubAuthPreference } from '@openslack/github';

export type PRBranchCleanupState =
  | 'CLEANUP_READY'
  | 'ALREADY_ABSENT'
  | 'DELETED'
  | 'ABSENT_AFTER_ATTEMPT'
  | 'FAILED'
  | 'RECONCILIATION_REQUIRED'
  | 'BLOCKED_NOT_MERGED'
  | 'BLOCKED_BASE_BRANCH'
  | 'BLOCKED_FORK'
  | 'BLOCKED_BRANCH_RESERVED'
  | 'BLOCKED_DEPENDENCY'
  | 'BLOCKED_SHA_DRIFT'
  | 'BLOCKED_EVIDENCE'
  | 'BLOCKED_AUTHORIZATION'
  | 'BLOCKED_AUDIT';

export interface PRBranchCleanupCheck {
  name: string;
  status: 'PASS' | 'FAIL' | 'N/A';
  detail?: string;
}

export interface PRBranchCleanupResult {
  state: PRBranchCleanupState;
  prNumber: number;
  repository: string;
  branch?: string;
  expectedSha?: string;
  observedSha?: string;
  observedRefState?: 'PRESENT' | 'ABSENT' | 'UNKNOWN';
  attempted: boolean;
  checks: PRBranchCleanupCheck[];
  reason: string;
  operationId: string;
  evidenceTimestamp: string;
  auditStatus: 'NOT_REQUIRED' | 'RECORDED' | 'FAILED';
}

export type PRBranchCleanupPlan = PRBranchCleanupResult;

export interface PRBranchCleanupAuditEvent {
  mode: 'preview' | 'execute';
  phase: 'requested' | 'outcome';
  operationId: string;
  repository: string;
  prNumber: number;
  branch?: string;
  expectedSha?: string;
  observedSha?: string;
  observedRefState?: 'PRESENT' | 'ABSENT' | 'UNKNOWN';
  state: PRBranchCleanupState;
  attempted: boolean;
  executor: string;
  authorizationSource: string;
  evidenceTimestamp: string;
}

export interface PRBranchCleanupInput {
  prNumber: number;
  rootDir: string;
  owner: string;
  repo: string;
  remote?: string;
  auth?: GitHubAuthPreference;
  timeoutMs?: number;
  execute?: boolean;
  context:
    | { kind: 'human-cli' }
    | { kind: 'agent'; principal: AgentPrincipal; snapshot: AgentPermissionSnapshot };
  audit?: (event: PRBranchCleanupAuditEvent) => Promise<void>;
}
