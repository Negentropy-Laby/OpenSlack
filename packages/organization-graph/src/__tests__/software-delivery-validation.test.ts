import { describe, expect, it } from 'vitest';
import {
  GraphContractError,
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
  type SoftwareDeliveryIssueObservation,
  type SoftwareDeliveryPrmsReportObservation,
  validateSoftwareDeliverySourceSnapshot,
} from '../index.js';
import { softwareDeliverySource } from './software-delivery-fixtures.js';

describe('software delivery source contract', () => {
  it('accepts a closed, explicitly batched source snapshot', () => {
    const source = softwareDeliverySource();
    const validated = validateSoftwareDeliverySourceSnapshot(source);
    expect(validated).toEqual(source);
    expect(validated.sources.reviews.status).toBe('observed');

    const maximumEvidenceRef = structuredClone(source);
    maximumEvidenceRef.sources.issues.items[0]!.evidenceRefs = ['e'.repeat(2_048)];
    expect(
      validateSoftwareDeliverySourceSnapshot(maximumEvidenceRef).sources.issues.items[0]!
        .evidenceRefs[0],
    ).toHaveLength(2_048);
  });

  it('rejects undeclared fields, missing authority versions, and unsafe external text', () => {
    const source = softwareDeliverySource();
    expect(() => validateSoftwareDeliverySourceSnapshot({ ...source, unexpected: true })).toThrow(
      /not an allowed property/,
    );

    const missingVersion = structuredClone(source);
    delete (missingVersion.sources.issues.items[0] as { authorityVersion?: string })
      .authorityVersion;
    expect(() => validateSoftwareDeliverySourceSnapshot(missingVersion)).toThrow(
      /authorityVersion.*required/,
    );

    const unsafeTitle = structuredClone(source);
    unsafeTitle.sources.pullRequests.items[0]!.title = '<script>steal()</script>';
    expect(() => validateSoftwareDeliverySourceSnapshot(unsafeTitle)).toThrow(
      /active content, a URL, or credential material/,
    );

    const secretDisplayName = structuredClone(source);
    secretDisplayName.sources.actors.items[0]!.actor.displayName = 'xoxb-1234567890-sensitive';
    expect(() => validateSoftwareDeliverySourceSnapshot(secretDisplayName)).toThrow(
      /credential material/,
    );
  });

  it('audits inert data descriptors before sizing without invoking accessors or toJSON', () => {
    let getterCalls = 0;
    const source = softwareDeliverySource() as unknown as Record<string, unknown>;
    Object.defineProperty(source, 'generatedAt', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return '2026-07-27T02:00:00.000Z';
      },
    });
    expect(() => validateSoftwareDeliverySourceSnapshot(source)).toThrow(
      /enumerable inert data property/,
    );
    expect(getterCalls).toBe(0);

    let toJsonCalls = 0;
    const custom = softwareDeliverySource() as unknown as Record<string, unknown>;
    Object.defineProperty(custom, 'toJSON', {
      enumerable: true,
      value() {
        toJsonCalls += 1;
        return {};
      },
    });
    expect(() => validateSoftwareDeliverySourceSnapshot(custom)).toThrow(/inert JSON data/);
    expect(toJsonCalls).toBe(0);

    class SourceSubclass {}
    expect(() => validateSoftwareDeliverySourceSnapshot(new SourceSubclass())).toThrow(
      /object prototype/,
    );
  });

  it('requires every requested source batch to state observed, incomplete, or missing', () => {
    const missing = structuredClone(softwareDeliverySource());
    missing.sources.checks = {
      status: 'missing',
      items: [],
      reasonCode: 'github-checks-unavailable',
    };
    expect(validateSoftwareDeliverySourceSnapshot(missing).sources.checks.status).toBe('missing');

    const incompleteWithoutReason = structuredClone(softwareDeliverySource());
    incompleteWithoutReason.sources.reviews = {
      status: 'incomplete',
      items: [],
      warningCodes: [],
    };
    expect(() => validateSoftwareDeliverySourceSnapshot(incompleteWithoutReason)).toThrow(
      /must explain an incomplete batch/,
    );

    const fakeMissing = structuredClone(softwareDeliverySource());
    fakeMissing.sources.merges = {
      status: 'missing',
      items: fakeMissing.sources.merges.items,
      reasonCode: 'unavailable',
    } as never;
    expect(() => validateSoftwareDeliverySourceSnapshot(fakeMissing)).toThrow(
      /must contain at most 0 items/,
    );
  });

  it('fails closed on duplicate references, labels, and semantic authority identities', () => {
    const duplicateReference = structuredClone(softwareDeliverySource());
    duplicateReference.sources.issues.items[0]!.assigneeIds.push('agent-1');
    expect(() => validateSoftwareDeliverySourceSnapshot(duplicateReference)).toThrow(
      /duplicates reference agent-1/,
    );

    const duplicateLabel = structuredClone(softwareDeliverySource());
    duplicateLabel.sources.issues.items[0]!.labels.push({
      name: 'high',
      category: 'risk',
    });
    expect(() => validateSoftwareDeliverySourceSnapshot(duplicateLabel)).toThrow(
      /duplicates label identity risk:high/,
    );

    const duplicateIssue = structuredClone(softwareDeliverySource());
    (duplicateIssue.sources.issues.items as SoftwareDeliveryIssueObservation[]).push({
      ...duplicateIssue.sources.issues.items[0]!,
      id: 'issue-alias-10',
      authorityVersion: 'issue-alias-version',
    });
    expect(() => validateSoftwareDeliverySourceSnapshot(duplicateIssue)).toThrow(
      /duplicates semantic authority identity repo-1#10/,
    );

    const conflictingPrms = structuredClone(softwareDeliverySource());
    (conflictingPrms.sources.prmsReports.items as SoftwareDeliveryPrmsReportObservation[]).push({
      ...conflictingPrms.sources.prmsReports.items[0]!,
      id: 'prms-conflict',
      authorityVersion: 'prms-conflict-version',
      status: 'blocked',
    });
    expect(() => validateSoftwareDeliverySourceSnapshot(conflictingPrms)).toThrow(
      /duplicates semantic authority identity pr-20:base-sha-1:head-sha-1/,
    );
  });

  it('enforces per-kind, aggregate-record, relation, and source-byte ceilings', () => {
    const overKind = structuredClone(softwareDeliverySource());
    const issue = overKind.sources.issues.items[0]!;
    overKind.sources.issues.items = Array.from(
      { length: SOFTWARE_DELIVERY_SOURCE_LIMITS.observationsPerKind + 1 },
      (_, index) => ({
        ...issue,
        id: `issue-${index + 100}`,
        authorityVersion: `issue-version-${index + 100}`,
        number: index + 100,
      }),
    );
    expect(() => validateSoftwareDeliverySourceSnapshot(overKind)).toThrow(
      /must contain at most 500 items/,
    );

    const overRelations = structuredClone(softwareDeliverySource());
    const openIssue = { ...issue };
    delete openIssue.closedAt;
    overRelations.sources.issues.items = Array.from({ length: 241 }, (_, issueIndex) => ({
      ...openIssue,
      id: `issue-relation-${issueIndex}`,
      authorityVersion: `issue-relation-version-${issueIndex}`,
      number: issueIndex + 100,
      assigneeIds: Array.from(
        { length: 50 },
        (_, actorIndex) => `actor-${issueIndex}-${actorIndex}`,
      ),
      state: 'open' as const,
      closureComplete: true,
    }));
    expect(() => validateSoftwareDeliverySourceSnapshot(overRelations)).toThrow(
      /relations; maximum is 12000/,
    );

    const overRecords = structuredClone(softwareDeliverySource());
    const actor = overRecords.sources.actors.items[0]!;
    overRecords.sources.actors.items = Array.from({ length: 500 }, (_, index) => ({
      ...actor,
      id: `actor-observation-${index}`,
      authorityVersion: `actor-version-${index}`,
      actor: { ...actor.actor, id: `actor-${index}` },
      sourceEventIds: [`event-actor-${index}`],
      evidenceRefs: [`evidence-actor-${index}`],
    }));
    overRecords.sources.issues.items = Array.from({ length: 500 }, (_, index) => ({
      ...issue,
      id: `issue-record-${index}`,
      authorityVersion: `issue-record-version-${index}`,
      number: index + 100,
      assigneeIds: [],
      sourceEventIds: [`event-issue-record-${index}`],
      evidenceRefs: [`evidence-issue-record-${index}`],
    }));
    const claim = overRecords.sources.claims.items[0]!;
    overRecords.sources.claims.items = Array.from({ length: 500 }, (_, index) => ({
      ...claim,
      id: `claim-record-${index}`,
      authorityVersion: `claim-record-version-${index}`,
      claimRef: `refs/heads/openslack/claims/record-${index}`,
      sourceEventIds: [`event-claim-record-${index}`],
      evidenceRefs: [`evidence-claim-record-${index}`],
    }));
    const worktree = overRecords.sources.worktrees.items[0]!;
    overRecords.sources.worktrees.items = Array.from({ length: 500 }, (_, index) => ({
      ...worktree,
      id: `worktree-observation-${index}`,
      authorityVersion: `worktree-version-${index}`,
      worktreeId: `worktree-record-${index}`,
      sourceEventIds: [`event-worktree-record-${index}`],
      evidenceRefs: [`evidence-worktree-record-${index}`],
    }));
    const commit = overRecords.sources.commits.items[0]!;
    overRecords.sources.commits.items = Array.from({ length: 500 }, (_, index) => ({
      ...commit,
      id: `commit-observation-${index}`,
      authorityVersion: `commit-version-${index}`,
      sha: `commit-sha-${index}`,
      issueIds: [],
      sourceEventIds: [`event-commit-record-${index}`],
      evidenceRefs: [`evidence-commit-record-${index}`],
    }));
    const check = overRecords.sources.checks.items[0]!;
    overRecords.sources.checks.items = Array.from({ length: 500 }, (_, index) => ({
      ...check,
      id: `check-record-${index}`,
      authorityVersion: `check-version-${index}`,
      name: `check-${index}`,
      sourceEventIds: [`event-check-record-${index}`],
      evidenceRefs: [`evidence-check-record-${index}`],
    }));
    expect(() => validateSoftwareDeliverySourceSnapshot(overRecords)).toThrow(
      /observations; maximum is 3000/,
    );

    const overBytes = structuredClone(softwareDeliverySource());
    overBytes.sources.pullRequests.items[0]!.title = 'x'.repeat(
      SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes,
    );
    expect(() => validateSoftwareDeliverySourceSnapshot(overBytes)).toThrow(GraphContractError);
  });

  it('rejects reversed lifecycle intervals before graph sealing', () => {
    const mutations: Array<(source: ReturnType<typeof softwareDeliverySource>) => void> = [
      (source) => {
        source.sources.issues.items[0]!.closedAt = '2026-07-26T23:00:00.000Z';
      },
      (source) => {
        source.sources.claims.items[0]!.expiresAt = '2026-07-27T00:00:00.000Z';
      },
      (source) => {
        source.sources.worktrees.items[0]!.closedAt = '2026-07-27T00:00:00.000Z';
      },
      (source) => {
        source.sources.pullRequests.items[0]!.updatedAt = '2026-07-27T00:00:00.000Z';
      },
      (source) => {
        source.sources.checks.items[0]!.completedAt = '2026-07-27T00:00:00.000Z';
      },
      (source) => {
        source.sources.workflowRuns.items[0]!.completedAt = '2026-07-27T00:00:00.000Z';
      },
      (source) => {
        source.sources.agentRuns.items[0]!.completedAt = '2026-07-27T00:00:00.000Z';
      },
      (source) => {
        source.sources.handoffs.items[0]!.closedAt = '2026-07-27T00:00:00.000Z';
      },
      (source) => {
        source.sources.decisions.items[0]!.status = 'superseded';
        source.sources.decisions.items[0]!.supersededAt = '2026-07-27T00:00:00.000Z';
      },
    ];
    for (const mutate of mutations) {
      const source = softwareDeliverySource();
      mutate(source);
      expect(() => validateSoftwareDeliverySourceSnapshot(source)).toThrow(/must not precede/);
    }
  });
});
