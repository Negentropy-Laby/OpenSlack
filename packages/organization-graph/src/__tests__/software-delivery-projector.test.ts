import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  projectSoftwareDeliverySnapshot,
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
  validateSoftwareDeliverySourceSnapshot,
  verifyGraphSnapshotIntegrity,
  type SoftwareDeliveryActorObservation,
  type SoftwareDeliveryCommitObservation,
  type SoftwareDeliveryIssueObservation,
  type SoftwareDeliveryReviewObservation,
  type SoftwareDeliverySourceSnapshot,
} from '../index.js';
import { softwareDeliverySource } from './software-delivery-fixtures.js';

function nodesOf(source: SoftwareDeliverySourceSnapshot, type: string) {
  return projectSoftwareDeliverySnapshot(source).snapshot.nodes.filter(
    (node) => node.type === type,
  );
}

describe('software delivery projector', () => {
  it('maps the complete software delivery chain with explicit authority versions', () => {
    const { projectorId, snapshot } = projectSoftwareDeliverySnapshot(softwareDeliverySource());
    expect(projectorId).toBe('openslack.software_delivery.v1');
    expect(verifyGraphSnapshotIntegrity(snapshot)).toBe(true);
    for (const type of [
      'core.work_item',
      'execution_lease',
      'execution_context',
      'artifact_revision',
      'reviewable_deliverable',
      'verification_evidence',
      'human_decision',
      'accepted_transition',
      'outcome',
      'workflow_run',
      'agent_run',
      'prms_report',
      'coordination.handoff',
      'governance.decision',
    ]) {
      expect(
        snapshot.nodes.some((node) => node.type === type),
        type,
      ).toBe(true);
    }
    expect(
      snapshot.nodes.every(
        (node) => node.authorityRef.version.length > 0 && node.authorityRef.observedAt.length > 0,
      ),
    ).toBe(true);
    expect(
      snapshot.nodes.find((node) => node.type === 'reviewable_deliverable')?.properties,
    ).toMatchObject({
      baseSha: 'base-sha-1',
      headSha: 'head-sha-1',
      currentHeadBound: true,
    });
    expect(
      snapshot.nodes.find((node) => node.type === 'verification_evidence')?.properties,
    ).toMatchObject({ headSha: 'head-sha-1', currentHeadBound: true });
    expect(snapshot.nodes.find((node) => node.type === 'prms_report')?.properties).toMatchObject({
      baseSha: 'base-sha-1',
      headSha: 'head-sha-1',
      currentHeadBound: true,
    });
    expect(
      snapshot.nodes.find(
        (node) => node.type === 'organization.actor' && node.authorityRef.objectId === 'agent-1',
      )?.authorityRef.provider,
    ).toBe('openslack');
    expect(
      snapshot.nodes.find(
        (node) => node.type === 'organization.actor' && node.authorityRef.objectId === 'reviewer-1',
      )?.authorityRef.provider,
    ).toBe('github');
    expect(snapshot.nodes.some((node) => node.type === 'informational.actor_observation')).toBe(
      false,
    );
    expect(snapshot.completeness.sourcesObserved).toContain('organization.actors');
    expect(snapshot.completeness.missingSources).not.toContain('organization.actors');
    expect(snapshot.completeness.sourcesRequested).not.toContain('github.actors');
    expect(snapshot.edges.some((edge) => edge.type === 'hosts_run')).toBe(true);
    const reviewerActor = snapshot.nodes.find(
      (node) => node.type === 'organization.actor' && node.authorityRef.objectId === 'reviewer-1',
    );
    expect(reviewerActor?.title).toBe('Reviewer');
    expect(reviewerActor?.owners).toEqual([{ id: 'reviewer-1', kind: 'human' }]);
    expect(
      snapshot.nodes
        .flatMap((node) => node.owners)
        .every((owner) => owner.displayName === undefined),
    ).toBe(true);
  });

  it('promotes only the latest independent current-head human decision', () => {
    const snapshot = projectSoftwareDeliverySnapshot(softwareDeliverySource()).snapshot;
    expect(snapshot.nodes.filter((node) => node.type === 'human_decision')).toHaveLength(1);
    expect(
      snapshot.nodes.filter((node) => node.type === 'informational.review_observation'),
    ).toHaveLength(2);
    expect(snapshot.completeness.warnings).toContain('github.reviews.selfReview.review-self');
    expect(snapshot.completeness.missingSources).toContain(
      'github.reviews.currentHead.review-stale',
    );

    const laterChangeRequest = structuredClone(softwareDeliverySource());
    (laterChangeRequest.sources.reviews.items as SoftwareDeliveryReviewObservation[]).push({
      ...laterChangeRequest.sources.reviews.items[0]!,
      id: 'review-latest',
      authorityVersion: 'review-latest-version',
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-07-27T01:10:00.000Z',
      sourceEventIds: ['event-review-latest'],
      evidenceRefs: ['evidence-review-latest'],
    });
    const decisions = nodesOf(laterChangeRequest, 'human_decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.status).toBe('CHANGES_REQUESTED');

    const dismissed = structuredClone(softwareDeliverySource());
    dismissed.sources.reviews.items[0]!.submittedAt = '2026-07-27T10:00:00+08:00';
    (dismissed.sources.reviews.items as SoftwareDeliveryReviewObservation[]).push({
      ...dismissed.sources.reviews.items[0]!,
      id: 'review-dismissed',
      authorityVersion: 'review-dismissed-version',
      state: 'DISMISSED',
      submittedAt: '2026-07-27T03:00:00.000Z',
      sourceEventIds: ['event-review-dismissed'],
      evidenceRefs: ['evidence-review-dismissed'],
    });
    expect(nodesOf(dismissed, 'human_decision')).toHaveLength(0);
  });

  it('never treats a green check as approval', () => {
    const source = structuredClone(softwareDeliverySource());
    source.sources.reviews.items = [];
    const snapshot = projectSoftwareDeliverySnapshot(source).snapshot;
    expect(snapshot.nodes.some((node) => node.type === 'verification_evidence')).toBe(true);
    expect(snapshot.nodes.some((node) => node.type === 'human_decision')).toBe(false);
  });

  it('keeps cache and synthetic PR, review, PRMS, and merge evidence informational', () => {
    const source = structuredClone(softwareDeliverySource());
    source.sources.pullRequests.items[0]!.observationKind = 'cache';
    source.sources.reviews.items[0]!.observationKind = 'cache';
    source.sources.prmsReports.items[0]!.observationKind = 'cache';
    source.sources.merges.items[0]!.observationKind = 'synthetic';
    const snapshot = projectSoftwareDeliverySnapshot(source).snapshot;
    expect(snapshot.nodes.some((node) => node.type === 'reviewable_deliverable')).toBe(false);
    expect(snapshot.nodes.some((node) => node.type === 'human_decision')).toBe(false);
    expect(snapshot.nodes.some((node) => node.type === 'prms_report')).toBe(false);
    expect(snapshot.nodes.some((node) => node.type === 'accepted_transition')).toBe(false);
    expect(snapshot.nodes.some((node) => node.type === 'informational.pr_observation')).toBe(true);
    expect(snapshot.nodes.some((node) => node.type === 'informational.prms_observation')).toBe(
      true,
    );
    expect(snapshot.completeness.missingSources).toEqual(
      expect.arrayContaining([
        'github.pullRequests',
        'github.reviews',
        'github.merges',
        'openslack.prmsReports',
      ]),
    );
  });

  it('never attributes a local-store GitHub observation to GitHub authority', () => {
    const source = structuredClone(softwareDeliverySource());
    source.sources.issues.items[0]!.observationKind = 'local_store';
    const issue = projectSoftwareDeliverySnapshot(source).snapshot.nodes.find(
      (node) => node.type === 'informational.issue_observation',
    );
    expect(issue?.authorityRef.provider).toBe('openslack');
    expect(nodesOf(source, 'core.work_item')).toHaveLength(0);
  });

  it('represents missing head, target, worktree, closure, and dangling evidence as incomplete', () => {
    const source = structuredClone(softwareDeliverySource());
    delete source.sources.pullRequests.items[0]!.headSha;
    delete source.sources.claims.items[0]!.targetSha;
    delete source.sources.worktrees.items[0]!.baseSha;
    source.sources.issues.items[0]!.assigneesComplete = false;
    source.sources.handoffs.items[0]!.issueId = 'missing-issue';
    const snapshot = projectSoftwareDeliverySnapshot(source).snapshot;
    expect(snapshot.completeness.missingSources).toEqual(
      expect.arrayContaining([
        'github.pullRequests.currentHead.pr-20',
        'openslack.claims.target.claim-10',
        'openslack.worktrees.base.worktree-10-observation',
        'github.issues.assignees.issue-10',
        'reference.handoff-issue.handoff-1',
      ]),
    );
    expect(snapshot.completeness.warnings).toContain('dangling.handoff-issue.handoff-1');
  });

  it('reports a dangling worktree-to-agent-run reference without inventing a relation', () => {
    const baseline = projectSoftwareDeliverySnapshot(softwareDeliverySource()).snapshot;
    const source = structuredClone(softwareDeliverySource());
    source.sources.worktrees.items[0]!.agentRunId = 'missing-agent-run';
    const snapshot = projectSoftwareDeliverySnapshot(source).snapshot;

    expect(snapshot.edges.some((edge) => edge.type === 'hosts_run')).toBe(false);
    expect(snapshot.completeness.warnings).toContain(
      'dangling.worktree-agentRun.worktree-10-observation',
    );
    expect(snapshot.completeness.missingSources).toContain(
      'reference.worktree-agentRun.worktree-10-observation',
    );
    expect(snapshot.integrityHash).not.toBe(baseline.integrityHash);
  });

  it('does not project an elapsed active claim as a current execution lease', () => {
    const source = structuredClone(softwareDeliverySource());
    source.sources.claims.items[0]!.expiresAt = source.generatedAt;
    const snapshot = projectSoftwareDeliverySnapshot(source).snapshot;
    expect(snapshot.nodes.some((node) => node.type === 'execution_lease')).toBe(false);
    expect(snapshot.nodes.some((node) => node.type === 'informational.claim_observation')).toBe(
      true,
    );
    expect(snapshot.completeness.missingSources).toContain('openslack.claims.freshness.claim-10');
  });

  it('keeps high-fanout edge evidence compact and within the store file ceiling', () => {
    const source = structuredClone(softwareDeliverySource());
    const commit = source.sources.commits.items[0]!;
    const commits = Array.from({ length: 100 }, (_, index) => ({
      ...commit,
      id: `commit-fanout-observation-${index}`,
      authorityVersion: `commit-fanout-version-${index}`,
      sha: `commit-fanout-sha-${index}`,
      sourceEventIds: Array.from({ length: 50 }, (__, ref) => `event-${index}-${ref}`),
      evidenceRefs: Array.from({ length: 50 }, (__, ref) => `evidence-${index}-${ref}`),
    }));
    source.sources.commits.items = commits as SoftwareDeliveryCommitObservation[];
    source.sources.pullRequests.items[0]!.commitShas = commits.map((item) => item.sha);
    const snapshot = projectSoftwareDeliverySnapshot(source).snapshot;
    expect(snapshot.edges.every((edge) => edge.sourceEventIds.length <= 1)).toBe(true);
    expect(snapshot.edges.every((edge) => edge.evidenceRefs.length <= 1)).toBe(true);
    expect(
      snapshot.edges.every((edge) =>
        edge.sourceEventIds.every((ref) => /^source-event:sha256:[0-9a-f]{64}$/.test(ref)),
      ),
    ).toBe(true);
    expect(
      snapshot.edges.every((edge) =>
        edge.evidenceRefs.every((ref) => /^evidence:sha256:[0-9a-f]{64}$/.test(ref)),
      ),
    ).toBe(true);
    expect(Buffer.byteLength(canonicalJson(snapshot), 'utf8') + 1).toBeLessThanOrEqual(
      SOFTWARE_DELIVERY_SOURCE_LIMITS.projectedSnapshotBytes,
    );
  });

  it('rejects max-length evidence fanout at source ingress before projection expansion', () => {
    const source = structuredClone(softwareDeliverySource());
    const commit = source.sources.commits.items[0]!;
    const maxRef = (prefix: string, item: number, ref: number) => {
      const suffix = `-${item}-${ref}`;
      return `${prefix}${'x'.repeat(2_048 - prefix.length - suffix.length)}${suffix}`;
    };
    const commits = Array.from({ length: 100 }, (_, index) => ({
      ...commit,
      id: `max-ref-commit-observation-${index}`,
      authorityVersion: `max-ref-commit-version-${index}`,
      sha: `max-ref-commit-sha-${index}`,
      sourceEventIds: Array.from({ length: 50 }, (__, ref) => maxRef('s', index, ref)),
      evidenceRefs: Array.from({ length: 50 }, (__, ref) => maxRef('e', index, ref)),
    }));
    source.sources.commits.items = commits as SoftwareDeliveryCommitObservation[];
    source.sources.pullRequests.items[0]!.commitShas = commits.map((item) => item.sha);
    expect(() => projectSoftwareDeliverySnapshot(source)).toThrow(
      /source exceeds 4194304 JSON bytes/,
    );
  });

  it('rejects source-valid projection amplification during preflight', () => {
    const source = structuredClone(softwareDeliverySource());
    source.scenarioDefinitionId = `definition-${'d'.repeat(501)}`;
    source.scenarioInstanceId = `instance-${'i'.repeat(503)}`;
    const maxRef = (prefix: string, index: number) => {
      const suffix = `-${index}`;
      return `${prefix}${'x'.repeat(2_048 - prefix.length - suffix.length)}${suffix}`;
    };
    const issueTemplate = source.sources.issues.items[0]!;
    const issues = Array.from({ length: 500 }, (_, index) => ({
      ...issueTemplate,
      id: `amplified-issue-${index}`,
      authorityVersion: `amplified-issue-version-${index}`,
      number: 1_000 + index,
      title: `Amplified issue ${index}`,
      assigneeIds: [],
      labels: [],
      sourceEventIds: [maxRef('s', index)],
      evidenceRefs: [maxRef('e', index)],
    }));
    const commitTemplate = structuredClone(source.sources.commits.items[0]!);
    delete commitTemplate.worktreeId;
    const commits = Array.from({ length: 500 }, (_, index) => ({
      ...commitTemplate,
      id: `amplified-commit-${index}`,
      authorityVersion: `amplified-commit-version-${index}`,
      sha: `amplified-commit-sha-${index}`,
      issueIds: Array.from(
        { length: 21 },
        (__, offset) => issues[(index + offset) % issues.length]!.id,
      ),
      sourceEventIds: [`amplified-commit-event-${index}`],
      evidenceRefs: [`amplified-commit-evidence-${index}`],
    }));
    source.sources.issues.items = issues as SoftwareDeliveryIssueObservation[];
    source.sources.claims.items = [];
    source.sources.worktrees.items = [];
    source.sources.commits.items = commits as SoftwareDeliveryCommitObservation[];
    source.sources.pullRequests.items = [];
    source.sources.checks.items = [];
    source.sources.reviews.items = [];
    source.sources.merges.items = [];
    source.sources.workflowRuns.items = [];
    source.sources.agentRuns.items = [];
    source.sources.prmsReports.items = [];
    source.sources.handoffs.items = [];
    source.sources.decisions.items = [];

    expect(() => validateSoftwareDeliverySourceSnapshot(source)).not.toThrow();
    expect(() => projectSoftwareDeliverySnapshot(source)).toThrow(
      /projection preflight upper bound/,
    );
  });

  it('does not fan out actor display metadata through compact owner references', () => {
    const source = structuredClone(softwareDeliverySource());
    const actorTemplate = source.sources.actors.items[0]!;
    const actors = Array.from({ length: 50 }, (_, index) => ({
      ...actorTemplate,
      id: `fanout-actor-observation-${index}`,
      authorityVersion: `fanout-actor-version-${index}`,
      actor: {
        id: `fanout-actor-${index}`,
        kind: 'human' as const,
        displayName: `Actor ${index} ${'x'.repeat(500)}`,
      },
      sourceEventIds: [`fanout-actor-event-${index}`],
      evidenceRefs: [`fanout-actor-evidence-${index}`],
    }));
    const issueTemplate = source.sources.issues.items[0]!;
    const assigneeIds = actors.map((item) => item.actor.id);
    const issues = Array.from({ length: 230 }, (_, index) => ({
      ...issueTemplate,
      id: `owner-fanout-issue-${index}`,
      authorityVersion: `owner-fanout-issue-version-${index}`,
      number: 2_000 + index,
      title: `Owner fanout issue ${index}`,
      assigneeIds,
      labels: [],
      sourceEventIds: [`owner-fanout-issue-event-${index}`],
      evidenceRefs: [`owner-fanout-issue-evidence-${index}`],
    }));
    source.sources.actors.items = actors as SoftwareDeliveryActorObservation[];
    source.sources.issues.items = issues as SoftwareDeliveryIssueObservation[];
    source.sources.claims.items = [];
    source.sources.worktrees.items = [];
    source.sources.commits.items = [];
    source.sources.pullRequests.items = [];
    source.sources.checks.items = [];
    source.sources.reviews.items = [];
    source.sources.merges.items = [];
    source.sources.workflowRuns.items = [];
    source.sources.agentRuns.items = [];
    source.sources.prmsReports.items = [];
    source.sources.handoffs.items = [];
    source.sources.decisions.items = [];

    expect(() => validateSoftwareDeliverySourceSnapshot(source)).not.toThrow();
    const snapshot = projectSoftwareDeliverySnapshot(source).snapshot;
    expect(
      snapshot.nodes
        .flatMap((node) => node.owners)
        .every((owner) => owner.displayName === undefined),
    ).toBe(true);
    expect(
      snapshot.nodes.find(
        (node) =>
          node.type === 'organization.actor' && node.authorityRef.objectId === actors[0]!.actor.id,
      )?.title,
    ).toBe(actors[0]!.actor.displayName);
    expect(Buffer.byteLength(canonicalJson(snapshot), 'utf8') + 1).toBeLessThanOrEqual(
      SOFTWARE_DELIVERY_SOURCE_LIMITS.projectedSnapshotBytes,
    );
  });

  it('derives completeness only from source batches and binds it into integrity', () => {
    const source = softwareDeliverySource();
    const original = projectSoftwareDeliverySnapshot(source).snapshot;

    const changedCursor = structuredClone(source);
    changedCursor.cursor = 'source-cursor-002';
    expect(projectSoftwareDeliverySnapshot(changedCursor).snapshot.integrityHash).not.toBe(
      original.integrityHash,
    );

    const changedBatch = structuredClone(source);
    if (changedBatch.sources.checks.status !== 'missing') {
      changedBatch.sources.checks.batchVersion = 'batch-checks-v2';
    }
    expect(projectSoftwareDeliverySnapshot(changedBatch).snapshot.integrityHash).not.toBe(
      original.integrityHash,
    );

    const incomplete = structuredClone(source);
    incomplete.sources.checks = {
      status: 'incomplete',
      batchVersion: 'batch-checks-v1',
      observedAt: '2026-07-27T01:00:00.000Z',
      items: incomplete.sources.checks.items,
      warningCodes: ['checks-page-limit'],
    };
    const incompleteSnapshot = projectSoftwareDeliverySnapshot(incomplete).snapshot;
    expect(incompleteSnapshot.integrityHash).not.toBe(original.integrityHash);
    expect(incompleteSnapshot.completeness.missingSources).toContain('github.checks');
    expect(incompleteSnapshot.completeness.warnings).toContain('github.checks.checks-page-limit');
  });

  it('is deterministic under source and relation permutation and does not mutate input', () => {
    const source = softwareDeliverySource();
    const before = structuredClone(source);
    const first = projectSoftwareDeliverySnapshot(source).snapshot;
    expect(source).toEqual(before);

    const permuted = structuredClone(source);
    for (const batch of Object.values(permuted.sources)) {
      batch.items.reverse();
      if (batch.status !== 'missing') batch.warningCodes.reverse();
    }
    permuted.sources.issues.items[0]!.labels.reverse();
    permuted.sources.issues.items[0]!.assigneeIds.reverse();
    permuted.sources.pullRequests.items[0]!.issueIds.reverse();
    permuted.sources.pullRequests.items[0]!.commitShas.reverse();
    const second = projectSoftwareDeliverySnapshot(permuted).snapshot;
    expect(second.integrityHash).toBe(first.integrityHash);
    expect(second).toEqual(first);
  });
});
