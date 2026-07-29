import { describe, expect, it } from 'vitest';
import {
  CONTRACT_TO_DELIVERY_PROJECTOR_ID,
  CONTRACT_TO_DELIVERY_SOURCE_LIMITS,
  SOFTWARE_DELIVERY_PROJECTOR_ID,
  calculateGraphSnapshotIntegrity,
  projectContractToDeliverySnapshot,
  projectSoftwareDeliverySnapshot,
  type SoftwareDeliveryCommitObservation,
  type SoftwareDeliveryIssueObservation,
} from '../index.js';
import { authorityIdentity, contractToDeliverySource } from './contract-to-delivery-fixtures.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

type MutableContractToDeliverySource = DeepMutable<ReturnType<typeof contractToDeliverySource>>;

function mutableSource(): MutableContractToDeliverySource {
  return structuredClone(contractToDeliverySource()) as MutableContractToDeliverySource;
}

function businessTypes(snapshot: ReturnType<typeof projectContractToDeliverySnapshot>['snapshot']) {
  return snapshot.nodes
    .filter((node) => node.type.startsWith('business.'))
    .map((node) => node.type)
    .sort();
}

describe('Contract-to-Delivery composite projector', () => {
  it('preserves the Software Delivery graph and connects the complete business story', () => {
    const source = contractToDeliverySource();
    const nested = projectSoftwareDeliverySnapshot(source.softwareDelivery).snapshot;
    const { snapshot, projectorId } = projectContractToDeliverySnapshot(source);

    expect(projectorId).toBe(CONTRACT_TO_DELIVERY_PROJECTOR_ID);
    expect(snapshot.projectorVersion).toBe(CONTRACT_TO_DELIVERY_PROJECTOR_ID);
    expect(snapshot.scenarioInstanceId).toBe(source.scenarioInstanceId);
    expect(snapshot.cursor).toBe(source.cursor);
    expect(snapshot.integrityHash).toBe(calculateGraphSnapshotIntegrity(snapshot));

    for (const nestedNode of nested.nodes) {
      expect(snapshot.nodes.find((node) => node.id === nestedNode.id)).toEqual(nestedNode);
    }
    for (const nestedEdge of nested.edges) {
      expect(snapshot.edges.find((edge) => edge.id === nestedEdge.id)).toEqual(nestedEdge);
    }
    expect(
      snapshot.nodes
        .filter((node) => nested.nodes.some((candidate) => candidate.id === node.id))
        .every((node) => node.projectorVersion === SOFTWARE_DELIVERY_PROJECTOR_ID),
    ).toBe(true);
    expect(
      snapshot.nodes
        .filter((node) => node.type.startsWith('business.'))
        .every((node) => node.projectorVersion === CONTRACT_TO_DELIVERY_PROJECTOR_ID),
    ).toBe(true);

    expect(businessTypes(snapshot)).toEqual([
      'business.acceptance',
      'business.contract',
      'business.customer',
      'business.milestone',
      'business.outcome',
      'business.project',
    ]);
    expect(new Set(snapshot.edges.map((edge) => edge.type))).toEqual(
      expect.objectContaining(
        new Set([
          'accepted_as',
          'approved_by',
          'closes_work_item',
          'contract_delivered_by',
          'contracts_for',
          'delivers_project',
          'milestone_contains',
          'produces',
          'realizes',
          'scoped_to',
          'substantiated_by',
          'tracks_milestone',
          'transitioned_by',
        ]),
      ),
    );
    for (const edge of snapshot.edges.filter(
      (candidate) => candidate.projectorVersion === CONTRACT_TO_DELIVERY_PROJECTOR_ID,
    )) {
      expect(edge.evidenceRefs.length).toBeGreaterThan(0);
      expect(edge.sourceEventIds.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic under source permutation and does not mutate caller input', () => {
    const source = contractToDeliverySource();
    const before = structuredClone(source);
    const permuted = mutableSource();
    permuted.softwareDelivery.sources.actors.items.reverse();
    permuted.softwareDelivery.sources.reviews.items.reverse();

    expect(projectContractToDeliverySnapshot(permuted).snapshot).toEqual(
      projectContractToDeliverySnapshot(source).snapshot,
    );
    expect(source).toEqual(before);
  });

  it.each([
    {
      name: 'stale and self reviews',
      mutate: (source: MutableContractToDeliverySource) => {
        source.softwareDelivery.sources.reviews.items =
          source.softwareDelivery.sources.reviews.items.filter(
            (review) => review.id !== 'review-current',
          );
      },
    },
    {
      name: 'missing accepted transition',
      mutate: (source: MutableContractToDeliverySource) => {
        source.softwareDelivery.sources.merges.items = [];
      },
    },
    {
      name: 'synthetic pull request',
      mutate: (source: MutableContractToDeliverySource) => {
        source.softwareDelivery.sources.pullRequests.items[0]!.observationKind = 'synthetic';
      },
    },
    {
      name: 'cache pull request',
      mutate: (source: MutableContractToDeliverySource) => {
        source.softwareDelivery.sources.pullRequests.items[0]!.observationKind = 'cache';
      },
    },
  ])('keeps Acceptance and Outcome informational for $name', ({ mutate }) => {
    const source = mutableSource();
    mutate(source);
    const snapshot = projectContractToDeliverySnapshot(source).snapshot;

    expect(snapshot.nodes.some((node) => node.type === 'business.acceptance')).toBe(false);
    expect(snapshot.nodes.some((node) => node.type === 'business.outcome')).toBe(false);
    expect(
      snapshot.nodes.some((node) => node.type === 'informational.acceptance_observation'),
    ).toBe(true);
    expect(snapshot.nodes.some((node) => node.type === 'informational.outcome_observation')).toBe(
      true,
    );
  });

  it('does not treat a green check as Acceptance authority', () => {
    const source = mutableSource();
    source.softwareDelivery.sources.reviews.items = [];
    source.softwareDelivery.sources.merges.items = [];
    expect(source.softwareDelivery.sources.checks.items[0]!.conclusion).toBe('success');

    const snapshot = projectContractToDeliverySnapshot(source).snapshot;
    expect(snapshot.nodes.some((node) => node.type === 'verification_evidence')).toBe(true);
    expect(snapshot.nodes.some((node) => node.type === 'business.acceptance')).toBe(false);
  });

  it('does not treat a non-terminal check as Acceptance authority', () => {
    const source = mutableSource();
    source.softwareDelivery.sources.reviews.items = [];
    source.softwareDelivery.sources.merges.items = [];
    const check = source.softwareDelivery.sources.checks.items[0]!;
    check.status = 'in_progress';
    delete check.conclusion;
    delete check.completedAt;

    const snapshot = projectContractToDeliverySnapshot(source).snapshot;
    expect(snapshot.nodes.some((node) => node.type === 'verification_evidence')).toBe(false);
    expect(snapshot.nodes.some((node) => node.type === 'informational.check_observation')).toBe(
      true,
    );
    expect(snapshot.nodes.some((node) => node.type === 'business.acceptance')).toBe(false);
  });

  it('records a version-drifted missing bridge without a dangling authority edge', () => {
    const source = mutableSource();
    const bridge = source.business.milestones.items[0]!.workItem;
    const identity = authorityIdentity(bridge.authorityRef);
    bridge.authorityRef.version = `${bridge.authorityRef.version}-drift`;

    const snapshot = projectContractToDeliverySnapshot(source).snapshot;
    const milestone = snapshot.nodes.find((node) => node.type === 'business.milestone')!;
    expect(
      snapshot.edges.some(
        (edge) => edge.type === 'milestone_contains' && edge.from === milestone.id,
      ),
    ).toBe(false);
    expect(snapshot.completeness.missingSources).toContain(
      'contract-to-delivery.bridge.milestone.workItem.milestone-accepted-change',
    );
    expect(identity).not.toBe(authorityIdentity(bridge.authorityRef));
  });

  it('fails closed when bounded source evidence expands beyond the snapshot byte ceiling', () => {
    const source = mutableSource();
    const nested = source.softwareDelivery;
    source.scenarioInstanceId = `instance-${'i'.repeat(503)}`;
    nested.scenarioInstanceId = source.scenarioInstanceId;
    const maxRef = (prefix: string, index: number) => {
      const suffix = `-${index}`;
      return `${prefix}${'x'.repeat(2_048 - prefix.length - suffix.length)}${suffix}`;
    };
    const issueTemplate = nested.sources.issues.items[0]!;
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
    const commitTemplate = structuredClone(nested.sources.commits.items[0]!);
    delete commitTemplate.worktreeId;
    const commits = Array.from({ length: 500 }, (_, index) => ({
      ...commitTemplate,
      id: `amplified-commit-${index}`,
      authorityVersion: `amplified-commit-version-${index}`,
      sha: `amplified-commit-sha-${index}`,
      issueIds: Array.from(
        { length: 21 },
        (_value, offset) => issues[(index + offset) % issues.length]!.id,
      ),
      sourceEventIds: [`amplified-commit-event-${index}`],
      evidenceRefs: [`amplified-commit-evidence-${index}`],
    }));
    nested.sources.issues.items = issues as SoftwareDeliveryIssueObservation[];
    nested.sources.claims.items = [];
    nested.sources.worktrees.items = [];
    nested.sources.commits.items = commits as SoftwareDeliveryCommitObservation[];
    nested.sources.pullRequests.items = [];
    nested.sources.checks.items = [];
    nested.sources.reviews.items = [];
    nested.sources.merges.items = [];
    nested.sources.workflowRuns.items = [];
    nested.sources.agentRuns.items = [];
    nested.sources.prmsReports.items = [];
    nested.sources.handoffs.items = [];
    nested.sources.decisions.items = [];

    expect(Buffer.byteLength(JSON.stringify(source), 'utf8')).toBeLessThan(
      CONTRACT_TO_DELIVERY_SOURCE_LIMITS.sourceBytes,
    );
    expect(() => projectContractToDeliverySnapshot(source)).toThrow(
      /projection preflight upper bound/,
    );
  });
});
