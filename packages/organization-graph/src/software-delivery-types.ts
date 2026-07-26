import type { ActorRef, GraphSnapshot } from './types.js';

export const SOFTWARE_DELIVERY_SOURCE_SCHEMA =
  'openslack.software_delivery_source_snapshot.v1' as const;
export const SOFTWARE_DELIVERY_PROJECTOR_ID = 'openslack.software_delivery.v1' as const;

export const SOFTWARE_DELIVERY_SOURCE_LIMITS = Object.freeze({
  observationsPerKind: 500,
  totalObservations: 3_000,
  totalRelations: 12_000,
  sourceBytes: 4 * 1024 * 1024,
  sourceJsonNodes: 100_000,
  sourceObjectProperties: 128,
  sourceArrayItems: 12_000,
  projectedSnapshotBytes: 16 * 1024 * 1024,
  labelsPerIssue: 50,
  relationsPerObservation: 100,
  completenessEntries: 50,
  textBytes: 2_048,
} as const);

export type SoftwareDeliveryObservationSource = 'live' | 'local_store' | 'cache' | 'synthetic';

export interface SoftwareDeliveryEvidence {
  id: string;
  authorityVersion: string;
  observationKind: SoftwareDeliveryObservationSource;
  observedAt: string;
  sourceEventIds: string[];
  evidenceRefs: string[];
}

export interface SoftwareDeliveryRepositoryObservation extends SoftwareDeliveryEvidence {
  repositoryId: string;
  fullName: string;
  defaultBranch: string;
}

export interface SoftwareDeliveryActorObservation extends SoftwareDeliveryEvidence {
  authorityProvider: 'github' | 'openslack';
  actor: ActorRef;
}

export interface SoftwareDeliveryLabel {
  name: string;
  category: 'state' | 'risk' | 'capability' | 'other';
}

export interface SoftwareDeliveryIssueObservation extends SoftwareDeliveryEvidence {
  repositoryId: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: SoftwareDeliveryLabel[];
  assigneeIds: string[];
  assigneesComplete: boolean;
  closureComplete: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface SoftwareDeliveryClaimObservation extends SoftwareDeliveryEvidence {
  issueId: string;
  claimRef: string;
  targetSha?: string;
  status: 'active' | 'expired' | 'released';
  agentActorId: string;
  claimedAt: string;
  expiresAt: string;
}

export interface SoftwareDeliveryWorktreeObservation extends SoftwareDeliveryEvidence {
  issueId: string;
  claimId?: string;
  agentRunId?: string;
  worktreeId: string;
  baseSha?: string;
  branchName: string;
  status: 'active' | 'preserved' | 'cleaned';
  createdAt: string;
  closedAt?: string;
}

export interface SoftwareDeliveryCommitObservation extends SoftwareDeliveryEvidence {
  repositoryId: string;
  sha: string;
  issueIds: string[];
  worktreeId?: string;
  authoredAt: string;
}

export interface SoftwareDeliveryPullRequestObservation extends SoftwareDeliveryEvidence {
  repositoryId: string;
  number: number;
  title: string;
  authorActorId: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  baseSha?: string;
  headSha?: string;
  issueIds: string[];
  commitShas: string[];
  openedAt: string;
  updatedAt: string;
}

export interface SoftwareDeliveryCheckObservation extends SoftwareDeliveryEvidence {
  pullRequestId: string;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'stale'
    | 'startup_failure';
  headSha?: string;
  startedAt: string;
  completedAt?: string;
}

export interface SoftwareDeliveryReviewObservation extends SoftwareDeliveryEvidence {
  pullRequestId: string;
  actorId: string;
  actorKind: ActorRef['kind'];
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  commitOid?: string;
  submittedAt: string;
}

export interface SoftwareDeliveryMergeObservation extends SoftwareDeliveryEvidence {
  pullRequestId: string;
  headSha?: string;
  mergeCommitSha?: string;
  actorId: string;
  mergedAt: string;
}

export interface SoftwareDeliveryWorkflowRunObservation extends SoftwareDeliveryEvidence {
  workflowId: string;
  status:
    | 'created'
    | 'previewed'
    | 'confirmed'
    | 'pending'
    | 'running'
    | 'paused'
    | 'paused_waiting_approval'
    | 'resuming'
    | 'completed'
    | 'failed'
    | 'cancelled';
  issueIds: string[];
  pullRequestIds: string[];
  startedAt: string;
  completedAt?: string;
}

export interface SoftwareDeliveryAgentRunObservation extends SoftwareDeliveryEvidence {
  workflowRunId?: string;
  agentActorId: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  worktreeId?: string;
  startedAt: string;
  completedAt?: string;
}

export interface SoftwareDeliveryPrmsReportObservation extends SoftwareDeliveryEvidence {
  pullRequestId: string;
  baseSha?: string;
  headSha?: string;
  status: 'ready' | 'blocked' | 'needs_human_approval' | 'failed';
  blockerCount: number;
}

export interface SoftwareDeliveryHandoffObservation extends SoftwareDeliveryEvidence {
  status: 'open' | 'accepted' | 'closed';
  fromActorId: string;
  toActorId: string;
  issueId?: string;
  pullRequestId?: string;
  workflowRunId?: string;
  createdAt: string;
  closedAt?: string;
}

export interface SoftwareDeliveryDecisionObservation extends SoftwareDeliveryEvidence {
  topic: string;
  status: 'active' | 'superseded';
  decidedByActorId: string;
  issueId?: string;
  pullRequestId?: string;
  workflowRunId?: string;
  createdAt: string;
  supersededAt?: string;
}

export interface SoftwareDeliveryObservedBatch<T> {
  status: 'observed';
  batchVersion: string;
  observedAt: string;
  items: T[];
  warningCodes: string[];
}

export interface SoftwareDeliveryIncompleteBatch<T> {
  status: 'incomplete';
  batchVersion?: string;
  observedAt?: string;
  items: T[];
  warningCodes: string[];
}

export interface SoftwareDeliveryMissingBatch {
  status: 'missing';
  items: [];
  reasonCode: string;
}

export type SoftwareDeliverySourceBatch<T> =
  | SoftwareDeliveryObservedBatch<T>
  | SoftwareDeliveryIncompleteBatch<T>
  | SoftwareDeliveryMissingBatch;

export interface SoftwareDeliverySourceBatches {
  repository: SoftwareDeliverySourceBatch<SoftwareDeliveryRepositoryObservation>;
  actors: SoftwareDeliverySourceBatch<SoftwareDeliveryActorObservation>;
  issues: SoftwareDeliverySourceBatch<SoftwareDeliveryIssueObservation>;
  claims: SoftwareDeliverySourceBatch<SoftwareDeliveryClaimObservation>;
  worktrees: SoftwareDeliverySourceBatch<SoftwareDeliveryWorktreeObservation>;
  commits: SoftwareDeliverySourceBatch<SoftwareDeliveryCommitObservation>;
  pullRequests: SoftwareDeliverySourceBatch<SoftwareDeliveryPullRequestObservation>;
  checks: SoftwareDeliverySourceBatch<SoftwareDeliveryCheckObservation>;
  reviews: SoftwareDeliverySourceBatch<SoftwareDeliveryReviewObservation>;
  merges: SoftwareDeliverySourceBatch<SoftwareDeliveryMergeObservation>;
  workflowRuns: SoftwareDeliverySourceBatch<SoftwareDeliveryWorkflowRunObservation>;
  agentRuns: SoftwareDeliverySourceBatch<SoftwareDeliveryAgentRunObservation>;
  prmsReports: SoftwareDeliverySourceBatch<SoftwareDeliveryPrmsReportObservation>;
  handoffs: SoftwareDeliverySourceBatch<SoftwareDeliveryHandoffObservation>;
  decisions: SoftwareDeliverySourceBatch<SoftwareDeliveryDecisionObservation>;
}

export interface SoftwareDeliverySourceSnapshot {
  schema: typeof SOFTWARE_DELIVERY_SOURCE_SCHEMA;
  scenarioDefinitionId: string;
  scenarioInstanceId: string;
  cursor: string;
  generatedAt: string;
  projectorVersion: string;
  sources: SoftwareDeliverySourceBatches;
}

export interface SoftwareDeliveryProjectionResult {
  projectorId: typeof SOFTWARE_DELIVERY_PROJECTOR_ID;
  snapshot: GraphSnapshot;
}
