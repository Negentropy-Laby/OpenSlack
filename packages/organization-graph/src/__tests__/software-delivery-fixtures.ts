import {
  SOFTWARE_DELIVERY_SOURCE_SCHEMA,
  type SoftwareDeliveryEvidence,
  type SoftwareDeliveryObservedBatch,
  type SoftwareDeliverySourceSnapshot,
} from '../index.js';

const observedAt = '2026-07-27T01:00:00.000Z';

function evidence(
  id: string,
  observationKind: SoftwareDeliveryEvidence['observationKind'],
): SoftwareDeliveryEvidence {
  return {
    id,
    authorityVersion: `version-${id}`,
    observationKind,
    observedAt,
    sourceEventIds: [`event-${id}`],
    evidenceRefs: [`evidence-${id}`],
  };
}

function observed<T>(name: string, items: T[]): SoftwareDeliveryObservedBatch<T> {
  return {
    status: 'observed',
    batchVersion: `batch-${name}-v1`,
    observedAt,
    items,
    warningCodes: [],
  };
}

export function softwareDeliverySource(): SoftwareDeliverySourceSnapshot {
  return {
    schema: SOFTWARE_DELIVERY_SOURCE_SCHEMA,
    scenarioDefinitionId: 'software-delivery',
    scenarioInstanceId: 'scenario-delivery-001',
    cursor: 'source-cursor-001',
    generatedAt: '2026-07-27T02:00:00.000Z',
    projectorVersion: 'openslack.software_delivery.v1',
    sources: {
      repository: observed('repository', [
        {
          ...evidence('repo-1', 'live'),
          repositoryId: 'repo-1',
          fullName: 'acme/project',
          defaultBranch: 'main',
        },
      ]),
      actors: observed('actors', [
        {
          ...evidence('actor-author-observation', 'live'),
          authorityProvider: 'github',
          actor: { id: 'author-1', kind: 'human', displayName: 'Author' },
        },
        {
          ...evidence('actor-reviewer-observation', 'live'),
          authorityProvider: 'github',
          actor: { id: 'reviewer-1', kind: 'human', displayName: 'Reviewer' },
        },
        {
          ...evidence('actor-agent-observation', 'local_store'),
          authorityProvider: 'openslack',
          actor: { id: 'agent-1', kind: 'agent', displayName: 'Delivery Agent' },
        },
      ]),
      issues: observed('issues', [
        {
          ...evidence('issue-10', 'live'),
          repositoryId: 'repo-1',
          number: 10,
          title: 'Deliver governed change',
          state: 'closed',
          labels: [
            { name: 'high', category: 'risk' },
            { name: 'openslack:done', category: 'state' },
          ],
          assigneeIds: ['agent-1'],
          assigneesComplete: true,
          closureComplete: true,
          createdAt: '2026-07-27T00:00:00.000Z',
          updatedAt: '2026-07-27T01:40:00.000Z',
          closedAt: '2026-07-27T01:40:00.000Z',
        },
      ]),
      claims: observed('claims', [
        {
          ...evidence('claim-10', 'local_store'),
          issueId: 'issue-10',
          claimRef: 'refs/heads/openslack/claims/issue-10',
          targetSha: 'base-sha-1',
          status: 'active',
          agentActorId: 'agent-1',
          claimedAt: '2026-07-27T00:10:00.000Z',
          expiresAt: '2026-07-27T03:10:00.000Z',
        },
      ]),
      worktrees: observed('worktrees', [
        {
          ...evidence('worktree-10-observation', 'local_store'),
          issueId: 'issue-10',
          claimId: 'claim-10',
          agentRunId: 'agent-run-1',
          worktreeId: 'worktree-10',
          baseSha: 'base-sha-1',
          branchName: 'agent/issue-10',
          status: 'preserved',
          createdAt: '2026-07-27T00:15:00.000Z',
        },
      ]),
      commits: observed('commits', [
        {
          ...evidence('commit-observation-1', 'live'),
          repositoryId: 'repo-1',
          sha: 'head-sha-1',
          issueIds: ['issue-10'],
          worktreeId: 'worktree-10',
          authoredAt: '2026-07-27T00:30:00.000Z',
        },
      ]),
      pullRequests: observed('pullRequests', [
        {
          ...evidence('pr-20', 'live'),
          repositoryId: 'repo-1',
          number: 20,
          title: 'Deliver governed change',
          authorActorId: 'author-1',
          state: 'merged',
          draft: false,
          baseSha: 'base-sha-1',
          headSha: 'head-sha-1',
          issueIds: ['issue-10'],
          commitShas: ['head-sha-1'],
          openedAt: '2026-07-27T00:40:00.000Z',
          updatedAt: '2026-07-27T01:30:00.000Z',
        },
      ]),
      checks: observed('checks', [
        {
          ...evidence('check-1', 'live'),
          pullRequestId: 'pr-20',
          name: 'required-tests',
          status: 'completed',
          conclusion: 'success',
          headSha: 'head-sha-1',
          startedAt: '2026-07-27T00:45:00.000Z',
          completedAt: '2026-07-27T00:50:00.000Z',
        },
      ]),
      reviews: observed('reviews', [
        {
          ...evidence('review-current', 'live'),
          pullRequestId: 'pr-20',
          actorId: 'reviewer-1',
          actorKind: 'human',
          state: 'APPROVED',
          commitOid: 'head-sha-1',
          submittedAt: '2026-07-27T01:00:00.000Z',
        },
        {
          ...evidence('review-stale', 'live'),
          pullRequestId: 'pr-20',
          actorId: 'reviewer-1',
          actorKind: 'human',
          state: 'APPROVED',
          commitOid: 'old-head-sha',
          submittedAt: '2026-07-27T00:55:00.000Z',
        },
        {
          ...evidence('review-self', 'live'),
          pullRequestId: 'pr-20',
          actorId: 'author-1',
          actorKind: 'human',
          state: 'APPROVED',
          commitOid: 'head-sha-1',
          submittedAt: '2026-07-27T00:58:00.000Z',
        },
      ]),
      merges: observed('merges', [
        {
          ...evidence('merge-20', 'live'),
          pullRequestId: 'pr-20',
          headSha: 'head-sha-1',
          mergeCommitSha: 'merge-sha-1',
          actorId: 'reviewer-1',
          mergedAt: '2026-07-27T01:30:00.000Z',
        },
      ]),
      workflowRuns: observed('workflowRuns', [
        {
          ...evidence('workflow-run-1', 'local_store'),
          workflowId: 'software-delivery',
          status: 'completed',
          issueIds: ['issue-10'],
          pullRequestIds: ['pr-20'],
          startedAt: '2026-07-27T00:05:00.000Z',
          completedAt: '2026-07-27T01:35:00.000Z',
        },
      ]),
      agentRuns: observed('agentRuns', [
        {
          ...evidence('agent-run-1', 'local_store'),
          workflowRunId: 'workflow-run-1',
          agentActorId: 'agent-1',
          status: 'completed',
          worktreeId: 'worktree-10',
          startedAt: '2026-07-27T00:12:00.000Z',
          completedAt: '2026-07-27T01:20:00.000Z',
        },
      ]),
      prmsReports: observed('prmsReports', [
        {
          ...evidence('prms-20', 'local_store'),
          pullRequestId: 'pr-20',
          baseSha: 'base-sha-1',
          headSha: 'head-sha-1',
          status: 'ready',
          blockerCount: 0,
        },
      ]),
      handoffs: observed('handoffs', [
        {
          ...evidence('handoff-1', 'local_store'),
          status: 'closed',
          fromActorId: 'agent-1',
          toActorId: 'reviewer-1',
          issueId: 'issue-10',
          pullRequestId: 'pr-20',
          workflowRunId: 'workflow-run-1',
          createdAt: '2026-07-27T00:35:00.000Z',
          closedAt: '2026-07-27T01:10:00.000Z',
        },
      ]),
      decisions: observed('decisions', [
        {
          ...evidence('decision-1', 'local_store'),
          topic: 'Adopt governed delivery',
          status: 'active',
          decidedByActorId: 'reviewer-1',
          issueId: 'issue-10',
          pullRequestId: 'pr-20',
          workflowRunId: 'workflow-run-1',
          createdAt: '2026-07-27T01:05:00.000Z',
        },
      ]),
    },
  };
}
