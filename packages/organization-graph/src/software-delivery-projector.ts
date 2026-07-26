import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { GraphContractError } from './errors.js';
import { deriveGraphEdgeId, deriveGraphNodeId } from './identity.js';
import { sealGraphSnapshot } from './integrity.js';
import {
  SOFTWARE_DELIVERY_PROJECTOR_ID,
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
  type SoftwareDeliveryEvidence,
  type SoftwareDeliveryObservationSource,
  type SoftwareDeliveryProjectionResult,
  type SoftwareDeliveryPullRequestObservation,
  type SoftwareDeliverySourceBatch,
  type SoftwareDeliverySourceBatches,
  type SoftwareDeliverySourceSnapshot,
} from './software-delivery-types.js';
import { validateSoftwareDeliverySourceSnapshot } from './software-delivery-validation.js';
import type {
  ActorRef,
  AuthorityRef,
  GraphAuthorityProvider,
  GraphCompleteness,
  GraphEdge,
  GraphNode,
} from './types.js';

type SourceName = keyof SoftwareDeliverySourceBatches;

const SOURCE_NAMES = Object.freeze([
  'repository',
  'actors',
  'issues',
  'claims',
  'worktrees',
  'commits',
  'pullRequests',
  'checks',
  'reviews',
  'merges',
  'workflowRuns',
  'agentRuns',
  'prmsReports',
  'handoffs',
  'decisions',
] as const satisfies readonly SourceName[]);

const SOURCE_PROVIDER: Readonly<Record<SourceName, 'github' | 'openslack'>> = Object.freeze({
  repository: 'github',
  actors: 'github',
  issues: 'github',
  claims: 'openslack',
  worktrees: 'openslack',
  commits: 'github',
  pullRequests: 'github',
  checks: 'github',
  reviews: 'github',
  merges: 'github',
  workflowRuns: 'openslack',
  agentRuns: 'openslack',
  prmsReports: 'openslack',
  handoffs: 'openslack',
  decisions: 'openslack',
});

const MAX_COMPLETENESS_ENTRIES = 50;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => compare(left.id, right.id));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function observationPointer(
  evidence: SoftwareDeliveryEvidence,
  kind: 'source-event' | 'evidence',
): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        authorityVersion: evidence.authorityVersion,
        id: evidence.id,
        kind,
        observationKind: evidence.observationKind,
        observedAt: evidence.observedAt,
      }),
      'utf8',
    )
    .digest('hex');
  return `${kind}:sha256:${digest}`;
}

function authorityProvider(
  observationKind: SoftwareDeliveryObservationSource,
  naturalProvider: 'github' | 'openslack',
): GraphAuthorityProvider {
  if (observationKind === 'synthetic') return 'demo_fixture';
  if (observationKind === 'live') return naturalProvider;
  return 'openslack';
}

function authority(
  evidence: SoftwareDeliveryEvidence,
  naturalProvider: 'github' | 'openslack',
  objectType: string,
  objectId = evidence.id,
): AuthorityRef {
  return {
    provider: authorityProvider(evidence.observationKind, naturalProvider),
    objectType,
    objectId,
    version: evidence.authorityVersion,
    observedAt: evidence.observedAt,
  };
}

function nodeFrom(input: {
  source: SoftwareDeliverySourceSnapshot;
  type: string;
  title: string;
  status?: string;
  authorityRef: AuthorityRef;
  owners?: ActorRef[];
  properties?: Record<string, unknown>;
  sourceEventIds?: string[];
  evidenceRefs?: string[];
  validFrom: string;
  validTo?: string;
}): GraphNode {
  const node: GraphNode = {
    id: '',
    type: input.type,
    scenarioDefinitionId: input.source.scenarioDefinitionId,
    scenarioInstanceId: input.source.scenarioInstanceId,
    title: input.title,
    ...(input.status === undefined ? {} : { status: input.status }),
    authorityRef: input.authorityRef,
    owners: input.owners ?? [],
    properties: input.properties ?? {},
    sourceEventIds: uniqueSorted(input.sourceEventIds ?? []),
    evidenceRefs: uniqueSorted(input.evidenceRefs ?? []),
    projectorVersion: input.source.projectorVersion,
    validFrom: input.validFrom,
    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
  };
  node.id = deriveGraphNodeId({
    scenarioInstanceId: node.scenarioInstanceId,
    type: node.type,
    authorityRef: node.authorityRef,
  });
  return node;
}

function edgeFrom(input: {
  source: SoftwareDeliverySourceSnapshot;
  type: string;
  from: string;
  to: string;
  evidence?: SoftwareDeliveryEvidence;
  validFrom: string;
}): GraphEdge {
  const edge: GraphEdge = {
    id: '',
    type: input.type,
    from: input.from,
    to: input.to,
    scenarioInstanceId: input.source.scenarioInstanceId,
    sourceEventIds:
      input.evidence === undefined ? [] : [observationPointer(input.evidence, 'source-event')],
    evidenceRefs:
      input.evidence === undefined ? [] : [observationPointer(input.evidence, 'evidence')],
    projectorVersion: input.source.projectorVersion,
    validFrom: input.validFrom,
  };
  edge.id = deriveGraphEdgeId({
    scenarioInstanceId: edge.scenarioInstanceId,
    type: edge.type,
    from: edge.from,
    to: edge.to,
  });
  return edge;
}

function batchSourceToken(name: SourceName): string {
  if (name === 'actors') return 'organization.actors';
  return `${SOURCE_PROVIDER[name]}.${name}`;
}

function batchItems<T>(batch: SoftwareDeliverySourceBatch<T>): T[] {
  return batch.items;
}

function compactActor(actor: ActorRef): ActorRef {
  return { id: actor.id, kind: actor.kind };
}

function assertProjectionExpansionBudget(source: SoftwareDeliverySourceSnapshot): void {
  const batches = Object.values(source.sources);
  const observationCount = batches.reduce((total, batch) => total + batch.items.length, 0);
  const sourceBatchNodes = batches.filter(
    (batch) =>
      batch.status !== 'missing' &&
      batch.batchVersion !== undefined &&
      batch.observedAt !== undefined,
  ).length;
  const outcomeNodes = source.sources.issues.items.filter(
    (issue) =>
      issue.state === 'closed' &&
      issue.observationKind === 'live' &&
      issue.closureComplete &&
      issue.closedAt !== undefined,
  ).length;
  const nodeCount = observationCount + sourceBatchNodes + outcomeNodes;
  const relationCount =
    source.sources.issues.items.reduce(
      (total, item) => total + 1 + item.assigneeIds.length + Number(item.state === 'closed'),
      0,
    ) +
    source.sources.claims.items.length * 2 +
    source.sources.worktrees.items.reduce(
      (total, item) =>
        total + 1 + Number(item.claimId !== undefined) + Number(item.agentRunId !== undefined),
      0,
    ) +
    source.sources.commits.items.reduce(
      (total, item) => total + item.issueIds.length + Number(item.worktreeId !== undefined),
      0,
    ) +
    source.sources.pullRequests.items.reduce(
      (total, item) => total + item.issueIds.length + item.commitShas.length,
      0,
    ) +
    source.sources.checks.items.length +
    source.sources.reviews.items.length +
    source.sources.merges.items.length +
    source.sources.workflowRuns.items.reduce(
      (total, item) => total + item.issueIds.length + item.pullRequestIds.length,
      0,
    ) +
    source.sources.agentRuns.items.reduce(
      (total, item) =>
        total +
        1 +
        Number(item.workflowRunId !== undefined) +
        Number(item.worktreeId !== undefined),
      0,
    ) +
    source.sources.prmsReports.items.length +
    source.sources.handoffs.items.reduce(
      (total, item) =>
        total +
        2 +
        Number(item.issueId !== undefined) +
        Number(item.pullRequestId !== undefined) +
        Number(item.workflowRunId !== undefined),
      0,
    ) +
    source.sources.decisions.items.reduce(
      (total, item) =>
        total +
        Number(item.issueId !== undefined) +
        Number(item.pullRequestId !== undefined) +
        Number(item.workflowRunId !== undefined),
      0,
    );
  const sourceBytes = Buffer.byteLength(canonicalJson(source), 'utf8');
  const actorById = new Map(
    source.sources.actors.items.map((observation) => [
      observation.actor.id,
      compactActor(observation.actor),
    ]),
  );
  const compactOwnerBytes = (actorIds: readonly string[]): number =>
    actorIds.reduce((total, actorId) => {
      const actor = actorById.get(actorId);
      return (
        total + (actor === undefined ? 0 : Buffer.byteLength(canonicalJson(actor), 'utf8') + 1)
      );
    }, 0);
  const ownerBytes =
    compactOwnerBytes(source.sources.actors.items.map((item) => item.actor.id)) +
    source.sources.issues.items.reduce(
      (total, item) =>
        total +
        compactOwnerBytes(item.assigneeIds) *
          (1 +
            Number(
              item.state === 'closed' &&
                item.observationKind === 'live' &&
                item.closureComplete &&
                item.closedAt !== undefined,
            )),
      0,
    ) +
    compactOwnerBytes(source.sources.claims.items.map((item) => item.agentActorId)) +
    compactOwnerBytes(source.sources.pullRequests.items.map((item) => item.authorActorId)) +
    compactOwnerBytes(source.sources.reviews.items.map((item) => item.actorId)) +
    compactOwnerBytes(source.sources.agentRuns.items.map((item) => item.agentActorId)) +
    compactOwnerBytes(source.sources.decisions.items.map((item) => item.decidedByActorId));
  const scopeNodeBytes =
    Buffer.byteLength(source.scenarioDefinitionId, 'utf8') +
    Buffer.byteLength(source.scenarioInstanceId, 'utf8');
  const scopeEdgeBytes = Buffer.byteLength(source.scenarioInstanceId, 'utf8');
  const conservativeUpperBound =
    sourceBytes * 4 +
    nodeCount * (scopeNodeBytes + 1_024) +
    relationCount * (scopeEdgeBytes + 1_024) +
    ownerBytes +
    64 * 1_024;
  if (conservativeUpperBound > SOFTWARE_DELIVERY_SOURCE_LIMITS.projectedSnapshotBytes) {
    throw new GraphContractError(
      'GRAPH_BOUND_EXCEEDED',
      '$.sources',
      `projection preflight upper bound ${conservativeUpperBound} bytes exceeds ${SOFTWARE_DELIVERY_SOURCE_LIMITS.projectedSnapshotBytes}.`,
    );
  }
}

class ProjectionBuilder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  readonly sourceNodes = new Map<string, string>();
  readonly warnings = new Set<string>();
  readonly missing = new Set<string>();

  constructor(readonly source: SoftwareDeliverySourceSnapshot) {}

  addNode(sourceKind: string, sourceId: string, node: GraphNode): void {
    const existing = this.nodes.get(node.id);
    if (existing !== undefined) {
      throw new GraphContractError(
        'GRAPH_REFERENCE_INVALID',
        '$.sources',
        `projection produced duplicate graph identity ${node.id}.`,
      );
    }
    this.nodes.set(node.id, node);
    this.sourceNodes.set(`${sourceKind}:${sourceId}`, node.id);
  }

  find(sourceKind: string, sourceId: string): string | undefined {
    return this.sourceNodes.get(`${sourceKind}:${sourceId}`);
  }

  addEdge(
    type: string,
    from: string | undefined,
    to: string | undefined,
    evidence: SoftwareDeliveryEvidence,
    relationCode: string,
  ): void {
    if (from === undefined || to === undefined) {
      this.warn(`dangling.${relationCode}.${evidence.id}`);
      this.incomplete(`reference.${relationCode}.${evidence.id}`);
      return;
    }
    const edge = edgeFrom({
      source: this.source,
      type,
      from,
      to,
      evidence,
      validFrom: evidence.observedAt,
    });
    if (!this.edges.has(edge.id)) this.edges.set(edge.id, edge);
  }

  warn(code: string): void {
    this.warnings.add(code);
  }

  incomplete(code: string): void {
    this.missing.add(code);
  }

  completeness(): GraphCompleteness {
    const requested = SOURCE_NAMES.map(batchSourceToken);
    const observed: string[] = [];
    const missing: string[] = [...this.missing];
    const warnings: string[] = [...this.warnings];
    for (const name of SOURCE_NAMES) {
      const batch = this.source.sources[name];
      const token = batchSourceToken(name);
      const expectedKind = SOURCE_PROVIDER[name] === 'github' ? 'live' : 'local_store';
      const nonCurrentItems = batch.items.filter(
        (item) =>
          item.observationKind !==
          (name === 'actors' && 'authorityProvider' in item
            ? item.authorityProvider === 'github'
              ? 'live'
              : 'local_store'
            : expectedKind),
      ).length;
      if (batch.status === 'observed' && nonCurrentItems === 0) observed.push(token);
      else missing.push(token);
      if (batch.status === 'missing') warnings.push(`${token}.${batch.reasonCode}`);
      else {
        warnings.push(...batch.warningCodes.map((code) => `${token}.${code}`));
        if (nonCurrentItems > 0) warnings.push(`${token}.non-current-items`);
      }
    }
    return {
      sourcesRequested: this.bound(requested, 'sources-requested'),
      sourcesObserved: this.bound(observed, 'sources-observed'),
      missingSources: this.bound(missing, 'missing-sources'),
      warnings: this.bound(warnings, 'warnings'),
    };
  }

  private bound(values: readonly string[], suffix: string): string[] {
    const canonical = uniqueSorted(values);
    if (canonical.length <= MAX_COMPLETENESS_ENTRIES) return canonical;
    return [
      ...canonical.slice(0, MAX_COMPLETENESS_ENTRIES - 1),
      `projection.${suffix}.truncated`,
    ].sort(compare);
  }
}

function addSourceBatchNodes(builder: ProjectionBuilder): void {
  for (const name of SOURCE_NAMES) {
    const batch = builder.source.sources[name];
    if (
      batch.status === 'missing' ||
      batch.batchVersion === undefined ||
      batch.observedAt === undefined
    ) {
      continue;
    }
    const authorityRef: AuthorityRef = {
      provider: 'openslack',
      objectType: 'source_batch',
      objectId: batchSourceToken(name),
      version: batch.batchVersion,
      observedAt: batch.observedAt,
    };
    const node = nodeFrom({
      source: builder.source,
      type: 'projection.source_batch',
      title: batchSourceToken(name),
      status: batch.status,
      authorityRef,
      properties: {
        recordCount: batch.items.length,
        status: batch.status,
      },
      validFrom: batch.observedAt,
    });
    builder.addNode('sourceBatch', name, node);
  }
}

function addRepository(builder: ProjectionBuilder): void {
  for (const repository of sorted(batchItems(builder.source.sources.repository))) {
    const current = repository.observationKind === 'live';
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'software.repository' : 'informational.repository_observation',
      title: repository.fullName,
      status: current ? 'observed' : 'informational',
      authorityRef: authority(
        repository,
        'github',
        current ? 'repository' : 'repository_projection_observation',
        repository.repositoryId,
      ),
      properties: {
        currentAuthority: current,
        defaultBranch: repository.defaultBranch,
        observationKind: repository.observationKind,
      },
      sourceEventIds: repository.sourceEventIds,
      evidenceRefs: repository.evidenceRefs,
      validFrom: repository.observedAt,
    });
    builder.addNode('repository', repository.repositoryId, node);
    if (!current) builder.warn(`informational.repository.${repository.id}`);
  }
}

function addActors(builder: ProjectionBuilder): void {
  for (const actorObservation of sorted(batchItems(builder.source.sources.actors))) {
    const current =
      (actorObservation.authorityProvider === 'github' &&
        actorObservation.observationKind === 'live') ||
      (actorObservation.authorityProvider === 'openslack' &&
        actorObservation.observationKind === 'local_store');
    const actor = actorObservation.actor;
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'organization.actor' : 'informational.actor_observation',
      title: actor.displayName ?? actor.id,
      status: current ? 'observed' : 'informational',
      authorityRef: authority(
        actorObservation,
        actorObservation.authorityProvider,
        current ? 'actor' : 'actor_projection_observation',
        actor.id,
      ),
      owners: [compactActor(actor)],
      properties: { actorKind: actor.kind, observationKind: actorObservation.observationKind },
      sourceEventIds: actorObservation.sourceEventIds,
      evidenceRefs: actorObservation.evidenceRefs,
      validFrom: actorObservation.observedAt,
    });
    builder.addNode('actor', actor.id, node);
  }
}

function addIssues(builder: ProjectionBuilder): void {
  for (const issue of sorted(batchItems(builder.source.sources.issues))) {
    const current = issue.observationKind === 'live';
    const owners = issue.assigneeIds
      .map(
        (id) =>
          batchItems(builder.source.sources.actors).find((candidate) => candidate.actor.id === id)
            ?.actor,
      )
      .filter((actor): actor is ActorRef => actor !== undefined)
      .map(compactActor);
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'core.work_item' : 'informational.issue_observation',
      title: issue.title,
      status: issue.state,
      authorityRef: authority(issue, 'github', current ? 'issue' : 'issue_projection_observation'),
      owners,
      properties: {
        assigneesComplete: issue.assigneesComplete,
        closureComplete: issue.closureComplete,
        labels: uniqueSorted(issue.labels.map((label) => `${label.category}:${label.name}`)),
        number: issue.number,
        observationKind: issue.observationKind,
        repositoryId: issue.repositoryId,
      },
      sourceEventIds: issue.sourceEventIds,
      evidenceRefs: issue.evidenceRefs,
      validFrom: issue.createdAt,
    });
    builder.addNode('issue', issue.id, node);
    builder.addEdge(
      'contains',
      builder.find('repository', issue.repositoryId),
      node.id,
      issue,
      'repository-issue',
    );
    for (const assigneeId of uniqueSorted(issue.assigneeIds)) {
      builder.addEdge(
        'assigned_to',
        node.id,
        builder.find('actor', assigneeId),
        issue,
        'issue-assignee',
      );
    }
    if (!issue.assigneesComplete) builder.incomplete(`github.issues.assignees.${issue.id}`);
    if (!issue.closureComplete) builder.incomplete(`github.issues.closure.${issue.id}`);
    if (!current) builder.warn(`informational.issue.${issue.id}`);

    if (issue.state === 'closed') {
      if (!current || !issue.closureComplete || issue.closedAt === undefined) {
        builder.incomplete(`github.issues.outcome.${issue.id}`);
      } else {
        const outcome = nodeFrom({
          source: builder.source,
          type: 'outcome',
          title: `Issue ${issue.number} outcome`,
          status: 'completed',
          authorityRef: authority(issue, 'github', 'issue_outcome'),
          owners,
          properties: {
            closedAt: issue.closedAt,
            issueId: issue.id,
            issueVersion: issue.authorityVersion,
          },
          sourceEventIds: issue.sourceEventIds,
          evidenceRefs: issue.evidenceRefs,
          validFrom: issue.closedAt,
        });
        builder.addNode('outcome', issue.id, outcome);
        builder.addEdge('closes_as', node.id, outcome.id, issue, 'issue-outcome');
      }
    }
  }
}

function addClaims(builder: ProjectionBuilder): void {
  for (const claim of sorted(batchItems(builder.source.sources.claims))) {
    const activeLeaseFresh =
      claim.status !== 'active' ||
      Date.parse(claim.expiresAt) > Date.parse(builder.source.generatedAt);
    const current =
      claim.observationKind === 'local_store' && claim.targetSha !== undefined && activeLeaseFresh;
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'execution_lease' : 'informational.claim_observation',
      title: `Claim ${claim.claimRef}`,
      status: claim.status,
      authorityRef: authority(
        claim,
        'openslack',
        current ? 'claim_ref' : 'claim_projection_observation',
        claim.claimRef,
      ),
      owners: batchItems(builder.source.sources.actors)
        .filter((candidate) => candidate.actor.id === claim.agentActorId)
        .map((candidate) => compactActor(candidate.actor)),
      properties: {
        currentAuthority: current,
        expiresAt: claim.expiresAt,
        observationKind: claim.observationKind,
        ...(claim.targetSha === undefined ? {} : { targetSha: claim.targetSha }),
      },
      sourceEventIds: claim.sourceEventIds,
      evidenceRefs: claim.evidenceRefs,
      validFrom: claim.claimedAt,
    });
    builder.addNode('claim', claim.id, node);
    builder.addEdge(
      'leased_by',
      builder.find('issue', claim.issueId),
      node.id,
      claim,
      'issue-claim',
    );
    builder.addEdge(
      'owned_by',
      node.id,
      builder.find('actor', claim.agentActorId),
      claim,
      'claim-agent',
    );
    if (!current) {
      builder.incomplete(
        claim.targetSha === undefined
          ? `openslack.claims.target.${claim.id}`
          : `openslack.claims.freshness.${claim.id}`,
      );
    }
  }
}

function addWorktrees(builder: ProjectionBuilder): void {
  for (const worktree of sorted(batchItems(builder.source.sources.worktrees))) {
    const current =
      worktree.observationKind === 'local_store' &&
      worktree.baseSha !== undefined &&
      (worktree.status !== 'cleaned' || worktree.closedAt !== undefined);
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'execution_context' : 'informational.worktree_observation',
      title: `Worktree ${worktree.worktreeId}`,
      status: worktree.status,
      authorityRef: authority(
        worktree,
        'openslack',
        current ? 'worktree' : 'worktree_projection_observation',
        worktree.worktreeId,
      ),
      properties: {
        branchName: worktree.branchName,
        currentAuthority: current,
        observationKind: worktree.observationKind,
        ...(worktree.baseSha === undefined ? {} : { baseSha: worktree.baseSha }),
      },
      sourceEventIds: worktree.sourceEventIds,
      evidenceRefs: worktree.evidenceRefs,
      validFrom: worktree.createdAt,
      ...(worktree.closedAt === undefined ? {} : { validTo: worktree.closedAt }),
    });
    builder.addNode('worktree', worktree.worktreeId, node);
    builder.addEdge(
      'executes_in',
      builder.find('issue', worktree.issueId),
      node.id,
      worktree,
      'issue-worktree',
    );
    if (worktree.claimId !== undefined) {
      builder.addEdge(
        'executes_in',
        builder.find('claim', worktree.claimId),
        node.id,
        worktree,
        'claim-worktree',
      );
    }
    if (!current) builder.incomplete(`openslack.worktrees.base.${worktree.id}`);
  }
}

function addCommits(builder: ProjectionBuilder): void {
  for (const commit of sorted(batchItems(builder.source.sources.commits))) {
    const current = commit.observationKind === 'live';
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'artifact_revision' : 'informational.commit_observation',
      title: `Commit ${commit.sha.slice(0, 12)}`,
      status: current ? 'observed' : 'informational',
      authorityRef: authority(
        commit,
        'github',
        current ? 'commit' : 'commit_projection_observation',
        commit.sha,
      ),
      properties: {
        currentAuthority: current,
        observationKind: commit.observationKind,
        repositoryId: commit.repositoryId,
        sha: commit.sha,
      },
      sourceEventIds: commit.sourceEventIds,
      evidenceRefs: commit.evidenceRefs,
      validFrom: commit.authoredAt,
    });
    builder.addNode('commit', commit.sha, node);
    for (const issueId of uniqueSorted(commit.issueIds)) {
      builder.addEdge(
        'implemented_by',
        builder.find('issue', issueId),
        node.id,
        commit,
        'issue-commit',
      );
    }
    if (commit.worktreeId !== undefined) {
      builder.addEdge(
        'produces',
        builder.find('worktree', commit.worktreeId),
        node.id,
        commit,
        'worktree-commit',
      );
    }
    if (!current) builder.warn(`informational.commit.${commit.id}`);
  }
}

function isCurrentPullRequest(pr: SoftwareDeliveryPullRequestObservation): boolean {
  return pr.observationKind === 'live' && pr.baseSha !== undefined && pr.headSha !== undefined;
}

function addPullRequests(builder: ProjectionBuilder): void {
  for (const pullRequest of sorted(batchItems(builder.source.sources.pullRequests))) {
    const current = isCurrentPullRequest(pullRequest);
    const author = batchItems(builder.source.sources.actors).find(
      (candidate) => candidate.actor.id === pullRequest.authorActorId,
    )?.actor;
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'reviewable_deliverable' : 'informational.pr_observation',
      title: pullRequest.title,
      status: pullRequest.state,
      authorityRef: authority(
        pullRequest,
        'github',
        current ? 'pull_request' : 'pr_projection_observation',
      ),
      owners: author === undefined ? [] : [compactActor(author)],
      properties: {
        authorActorId: pullRequest.authorActorId,
        currentHeadBound: current,
        draft: pullRequest.draft,
        number: pullRequest.number,
        observationKind: pullRequest.observationKind,
        repositoryId: pullRequest.repositoryId,
        ...(pullRequest.baseSha === undefined ? {} : { baseSha: pullRequest.baseSha }),
        ...(pullRequest.headSha === undefined ? {} : { headSha: pullRequest.headSha }),
      },
      sourceEventIds: pullRequest.sourceEventIds,
      evidenceRefs: pullRequest.evidenceRefs,
      validFrom: pullRequest.openedAt,
    });
    builder.addNode('pullRequest', pullRequest.id, node);
    for (const issueId of uniqueSorted(pullRequest.issueIds)) {
      builder.addEdge('produces', builder.find('issue', issueId), node.id, pullRequest, 'issue-pr');
    }
    for (const commitSha of uniqueSorted(pullRequest.commitShas)) {
      builder.addEdge(
        'included_in',
        builder.find('commit', commitSha),
        node.id,
        pullRequest,
        'commit-pr',
      );
    }
    if (author === undefined) builder.incomplete(`github.pullRequests.author.${pullRequest.id}`);
    if (!current) {
      builder.incomplete(`github.pullRequests.currentHead.${pullRequest.id}`);
      builder.warn(`informational.pullRequest.${pullRequest.id}`);
    }
  }
}

function pullRequestById(
  source: SoftwareDeliverySourceSnapshot,
  id: string,
): SoftwareDeliveryPullRequestObservation | undefined {
  return batchItems(source.sources.pullRequests).find((candidate) => candidate.id === id);
}

function addChecks(builder: ProjectionBuilder): void {
  for (const check of sorted(batchItems(builder.source.sources.checks))) {
    const pullRequest = pullRequestById(builder.source, check.pullRequestId);
    const current =
      check.observationKind === 'live' &&
      pullRequest !== undefined &&
      isCurrentPullRequest(pullRequest) &&
      check.headSha !== undefined &&
      check.headSha === pullRequest.headSha &&
      (check.status !== 'completed' ||
        (check.conclusion !== undefined && check.completedAt !== undefined));
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'verification_evidence' : 'informational.check_observation',
      title: check.name,
      status: check.conclusion ?? check.status,
      authorityRef: authority(
        check,
        'github',
        current ? 'check_run' : 'check_projection_observation',
      ),
      properties: {
        currentHeadBound: current,
        observationKind: check.observationKind,
        status: check.status,
        ...(check.conclusion === undefined ? {} : { conclusion: check.conclusion }),
        ...(check.headSha === undefined ? {} : { headSha: check.headSha }),
      },
      sourceEventIds: check.sourceEventIds,
      evidenceRefs: check.evidenceRefs,
      validFrom: check.startedAt,
    });
    builder.addNode('check', check.id, node);
    builder.addEdge(
      'verified_by',
      builder.find('pullRequest', check.pullRequestId),
      node.id,
      check,
      'pr-check',
    );
    if (!current) {
      builder.incomplete(`github.checks.currentHead.${check.id}`);
      builder.warn(`informational.check.${check.id}`);
    }
  }
}

function addReviews(builder: ProjectionBuilder): void {
  const latestDecisiveReview = new Map<string, string>();
  const decisiveReviews = batchItems(builder.source.sources.reviews)
    .filter(
      (review) =>
        review.observationKind === 'live' &&
        review.actorKind === 'human' &&
        (review.state === 'APPROVED' ||
          review.state === 'CHANGES_REQUESTED' ||
          review.state === 'DISMISSED') &&
        review.commitOid !== undefined,
    )
    .sort((left, right) => {
      const time = Date.parse(left.submittedAt) - Date.parse(right.submittedAt);
      return time === 0 ? compare(left.id, right.id) : time;
    });
  for (const review of decisiveReviews) {
    latestDecisiveReview.set(
      `${review.pullRequestId}:${review.actorId}:${review.commitOid}`,
      review.id,
    );
  }
  for (const review of sorted(batchItems(builder.source.sources.reviews))) {
    const pullRequest = pullRequestById(builder.source, review.pullRequestId);
    const decisionState = review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED';
    const current =
      review.observationKind === 'live' &&
      review.actorKind === 'human' &&
      decisionState &&
      pullRequest !== undefined &&
      isCurrentPullRequest(pullRequest) &&
      review.commitOid !== undefined &&
      review.commitOid === pullRequest.headSha &&
      review.actorId !== pullRequest.authorActorId &&
      latestDecisiveReview.get(`${review.pullRequestId}:${review.actorId}:${review.commitOid}`) ===
        review.id;
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'human_decision' : 'informational.review_observation',
      title: current ? `Human review ${review.state}` : `Review observation ${review.state}`,
      status: review.state,
      authorityRef: authority(
        review,
        'github',
        current ? 'pull_request_review' : 'review_projection_observation',
      ),
      owners: batchItems(builder.source.sources.actors)
        .filter((candidate) => candidate.actor.id === review.actorId)
        .map((candidate) => compactActor(candidate.actor)),
      properties: {
        actorId: review.actorId,
        actorKind: review.actorKind,
        currentHeadBound: current,
        decisionState,
        independentReviewer:
          pullRequest === undefined ? false : review.actorId !== pullRequest.authorActorId,
        observationKind: review.observationKind,
        ...(review.commitOid === undefined ? {} : { commitOid: review.commitOid }),
      },
      sourceEventIds: review.sourceEventIds,
      evidenceRefs: review.evidenceRefs,
      validFrom: review.submittedAt,
    });
    builder.addNode('review', review.id, node);
    builder.addEdge(
      current ? 'reviewed_by' : 'observed_review',
      builder.find('pullRequest', review.pullRequestId),
      node.id,
      review,
      'pr-review',
    );
    if (!current) {
      builder.warn(`informational.review.${review.id}`);
      if (review.actorKind === 'human' && decisionState) {
        builder.incomplete(`github.reviews.currentHead.${review.id}`);
      }
      if (pullRequest !== undefined && review.actorId === pullRequest.authorActorId) {
        builder.warn(`github.reviews.selfReview.${review.id}`);
      }
    }
  }
}

function addMerges(builder: ProjectionBuilder): void {
  for (const merge of sorted(batchItems(builder.source.sources.merges))) {
    const pullRequest = pullRequestById(builder.source, merge.pullRequestId);
    const current =
      merge.observationKind === 'live' &&
      pullRequest !== undefined &&
      isCurrentPullRequest(pullRequest) &&
      pullRequest.state === 'merged' &&
      merge.headSha !== undefined &&
      merge.headSha === pullRequest.headSha &&
      merge.mergeCommitSha !== undefined;
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'accepted_transition' : 'informational.merge_observation',
      title: current ? 'Accepted merge transition' : 'Merge observation',
      status: current ? 'accepted' : 'informational',
      authorityRef: authority(merge, 'github', current ? 'merge' : 'merge_projection_observation'),
      properties: {
        actorId: merge.actorId,
        currentHeadBound: current,
        observationKind: merge.observationKind,
        ...(merge.headSha === undefined ? {} : { headSha: merge.headSha }),
        ...(merge.mergeCommitSha === undefined ? {} : { mergeCommitSha: merge.mergeCommitSha }),
      },
      sourceEventIds: merge.sourceEventIds,
      evidenceRefs: merge.evidenceRefs,
      validFrom: merge.mergedAt,
    });
    builder.addNode('merge', merge.id, node);
    builder.addEdge(
      current ? 'accepted_by' : 'observed_merge',
      builder.find('pullRequest', merge.pullRequestId),
      node.id,
      merge,
      'pr-merge',
    );
    if (!current) {
      builder.incomplete(`github.merges.currentHead.${merge.id}`);
      builder.warn(`informational.merge.${merge.id}`);
    }
  }
}

function addWorkflowRuns(builder: ProjectionBuilder): void {
  for (const workflow of sorted(batchItems(builder.source.sources.workflowRuns))) {
    const terminal =
      workflow.status === 'completed' ||
      workflow.status === 'failed' ||
      workflow.status === 'cancelled';
    const current =
      workflow.observationKind === 'local_store' &&
      (!terminal || workflow.completedAt !== undefined);
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'workflow_run' : 'informational.workflow_run_observation',
      title: `Workflow ${workflow.workflowId}`,
      status: workflow.status,
      authorityRef: authority(
        workflow,
        'openslack',
        current ? 'workflow_run' : 'workflow_projection_observation',
      ),
      properties: {
        currentAuthority: current,
        observationKind: workflow.observationKind,
        workflowId: workflow.workflowId,
      },
      sourceEventIds: workflow.sourceEventIds,
      evidenceRefs: workflow.evidenceRefs,
      validFrom: workflow.startedAt,
    });
    builder.addNode('workflowRun', workflow.id, node);
    for (const issueId of uniqueSorted(workflow.issueIds)) {
      builder.addEdge(
        'decomposes_to',
        node.id,
        builder.find('issue', issueId),
        workflow,
        'workflow-issue',
      );
    }
    for (const pullRequestId of uniqueSorted(workflow.pullRequestIds)) {
      builder.addEdge(
        'produces',
        node.id,
        builder.find('pullRequest', pullRequestId),
        workflow,
        'workflow-pr',
      );
    }
    if (!current) builder.warn(`informational.workflow.${workflow.id}`);
  }
}

function addAgentRuns(builder: ProjectionBuilder): void {
  for (const agentRun of sorted(batchItems(builder.source.sources.agentRuns))) {
    const terminal =
      agentRun.status === 'completed' ||
      agentRun.status === 'failed' ||
      agentRun.status === 'cancelled';
    const current =
      agentRun.observationKind === 'local_store' &&
      (!terminal || agentRun.completedAt !== undefined);
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'agent_run' : 'informational.agent_run_observation',
      title: `Agent run ${agentRun.id}`,
      status: agentRun.status,
      authorityRef: authority(
        agentRun,
        'openslack',
        current ? 'agent_run' : 'agent_run_projection_observation',
      ),
      owners: batchItems(builder.source.sources.actors)
        .filter((candidate) => candidate.actor.id === agentRun.agentActorId)
        .map((candidate) => compactActor(candidate.actor)),
      properties: {
        agentActorId: agentRun.agentActorId,
        currentAuthority: current,
        observationKind: agentRun.observationKind,
      },
      sourceEventIds: agentRun.sourceEventIds,
      evidenceRefs: agentRun.evidenceRefs,
      validFrom: agentRun.startedAt,
    });
    builder.addNode('agentRun', agentRun.id, node);
    if (agentRun.workflowRunId !== undefined) {
      builder.addEdge(
        'executed_by',
        builder.find('workflowRun', agentRun.workflowRunId),
        node.id,
        agentRun,
        'workflow-agentRun',
      );
    }
    builder.addEdge(
      'performed_by',
      node.id,
      builder.find('actor', agentRun.agentActorId),
      agentRun,
      'agentRun-actor',
    );
    if (agentRun.worktreeId !== undefined) {
      builder.addEdge(
        'executes_in',
        node.id,
        builder.find('worktree', agentRun.worktreeId),
        agentRun,
        'agentRun-worktree',
      );
    }
    if (!current) builder.warn(`informational.agentRun.${agentRun.id}`);
  }

  for (const worktree of sorted(batchItems(builder.source.sources.worktrees))) {
    if (worktree.agentRunId === undefined) continue;
    const agentRun = batchItems(builder.source.sources.agentRuns).find(
      (candidate) => candidate.id === worktree.agentRunId,
    );
    if (agentRun !== undefined && agentRun.worktreeId !== worktree.worktreeId) {
      builder.warn(`inconsistent.worktree-agentRun.${worktree.id}`);
      builder.incomplete(`reference.worktree-agentRun.${worktree.id}`);
      continue;
    }
    builder.addEdge(
      'hosts_run',
      builder.find('worktree', worktree.worktreeId),
      builder.find('agentRun', worktree.agentRunId),
      worktree,
      'worktree-agentRun',
    );
  }
}

function addPrmsReports(builder: ProjectionBuilder): void {
  for (const report of sorted(batchItems(builder.source.sources.prmsReports))) {
    const pullRequest = pullRequestById(builder.source, report.pullRequestId);
    const current =
      report.observationKind === 'local_store' &&
      pullRequest !== undefined &&
      isCurrentPullRequest(pullRequest) &&
      report.baseSha !== undefined &&
      report.headSha !== undefined &&
      report.baseSha === pullRequest.baseSha &&
      report.headSha === pullRequest.headSha;
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'prms_report' : 'informational.prms_observation',
      title: current ? 'PRMS current-head report' : 'PRMS observation',
      status: report.status,
      authorityRef: authority(
        report,
        'openslack',
        current ? 'prms_report' : 'prms_projection_observation',
      ),
      properties: {
        blockerCount: report.blockerCount,
        currentHeadBound: current,
        observationKind: report.observationKind,
        ...(report.baseSha === undefined ? {} : { baseSha: report.baseSha }),
        ...(report.headSha === undefined ? {} : { headSha: report.headSha }),
      },
      sourceEventIds: report.sourceEventIds,
      evidenceRefs: report.evidenceRefs,
      validFrom: report.observedAt,
    });
    builder.addNode('prmsReport', report.id, node);
    builder.addEdge(
      current ? 'assessed_by' : 'observed_assessment',
      builder.find('pullRequest', report.pullRequestId),
      node.id,
      report,
      'pr-prms',
    );
    if (!current) {
      builder.incomplete(`openslack.prmsReports.currentHead.${report.id}`);
      builder.warn(`informational.prms.${report.id}`);
    }
  }
}

function addHandoffs(builder: ProjectionBuilder): void {
  for (const handoff of sorted(batchItems(builder.source.sources.handoffs))) {
    const current = handoff.observationKind === 'local_store';
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'coordination.handoff' : 'informational.handoff_observation',
      title: `Handoff ${handoff.id}`,
      status: handoff.status,
      authorityRef: authority(
        handoff,
        'openslack',
        current ? 'handoff' : 'handoff_projection_observation',
      ),
      properties: {
        currentAuthority: current,
        fromActorId: handoff.fromActorId,
        observationKind: handoff.observationKind,
        toActorId: handoff.toActorId,
      },
      sourceEventIds: handoff.sourceEventIds,
      evidenceRefs: handoff.evidenceRefs,
      validFrom: handoff.createdAt,
    });
    builder.addNode('handoff', handoff.id, node);
    builder.addEdge(
      'from_actor',
      node.id,
      builder.find('actor', handoff.fromActorId),
      handoff,
      'handoff-from',
    );
    builder.addEdge(
      'to_actor',
      node.id,
      builder.find('actor', handoff.toActorId),
      handoff,
      'handoff-to',
    );
    if (handoff.issueId !== undefined) {
      builder.addEdge(
        'coordinates',
        node.id,
        builder.find('issue', handoff.issueId),
        handoff,
        'handoff-issue',
      );
    }
    if (handoff.pullRequestId !== undefined) {
      builder.addEdge(
        'coordinates',
        node.id,
        builder.find('pullRequest', handoff.pullRequestId),
        handoff,
        'handoff-pr',
      );
    }
    if (handoff.workflowRunId !== undefined) {
      builder.addEdge(
        'coordinates',
        node.id,
        builder.find('workflowRun', handoff.workflowRunId),
        handoff,
        'handoff-workflow',
      );
    }
    if (!current) builder.warn(`informational.handoff.${handoff.id}`);
  }
}

function addDecisions(builder: ProjectionBuilder): void {
  for (const decision of sorted(batchItems(builder.source.sources.decisions))) {
    const current = decision.observationKind === 'local_store';
    const node = nodeFrom({
      source: builder.source,
      type: current ? 'governance.decision' : 'informational.decision_observation',
      title: decision.topic,
      status: decision.status,
      authorityRef: authority(
        decision,
        'openslack',
        current ? 'decision' : 'decision_projection_observation',
      ),
      owners: batchItems(builder.source.sources.actors)
        .filter((candidate) => candidate.actor.id === decision.decidedByActorId)
        .map((candidate) => compactActor(candidate.actor)),
      properties: {
        currentAuthority: current,
        decidedByActorId: decision.decidedByActorId,
        observationKind: decision.observationKind,
      },
      sourceEventIds: decision.sourceEventIds,
      evidenceRefs: decision.evidenceRefs,
      validFrom: decision.createdAt,
    });
    builder.addNode('decision', decision.id, node);
    if (decision.issueId !== undefined) {
      builder.addEdge(
        'governs',
        node.id,
        builder.find('issue', decision.issueId),
        decision,
        'decision-issue',
      );
    }
    if (decision.pullRequestId !== undefined) {
      builder.addEdge(
        'governs',
        node.id,
        builder.find('pullRequest', decision.pullRequestId),
        decision,
        'decision-pr',
      );
    }
    if (decision.workflowRunId !== undefined) {
      builder.addEdge(
        'governs',
        node.id,
        builder.find('workflowRun', decision.workflowRunId),
        decision,
        'decision-workflow',
      );
    }
    if (!current) builder.warn(`informational.decision.${decision.id}`);
  }
}

export function projectSoftwareDeliverySnapshot(value: unknown): SoftwareDeliveryProjectionResult {
  const source = validateSoftwareDeliverySourceSnapshot(value);
  assertProjectionExpansionBudget(source);
  const builder = new ProjectionBuilder(source);

  addSourceBatchNodes(builder);
  addRepository(builder);
  addActors(builder);
  addIssues(builder);
  addClaims(builder);
  addWorktrees(builder);
  addCommits(builder);
  addPullRequests(builder);
  addChecks(builder);
  addReviews(builder);
  addMerges(builder);
  addWorkflowRuns(builder);
  addAgentRuns(builder);
  addPrmsReports(builder);
  addHandoffs(builder);
  addDecisions(builder);

  const snapshot = sealGraphSnapshot({
    schema: 'openslack.graph_snapshot.v1',
    cursor: source.cursor,
    scenarioInstanceId: source.scenarioInstanceId,
    generatedAt: source.generatedAt,
    projectorVersion: source.projectorVersion,
    nodes: [...builder.nodes.values()],
    edges: [...builder.edges.values()],
    completeness: builder.completeness(),
  });
  const projectedBytes = Buffer.byteLength(canonicalJson(snapshot), 'utf8') + 1;
  if (projectedBytes > SOFTWARE_DELIVERY_SOURCE_LIMITS.projectedSnapshotBytes) {
    throw new GraphContractError(
      'GRAPH_BOUND_EXCEEDED',
      '$.sources',
      `projected snapshot contains ${projectedBytes} bytes; maximum is ${SOFTWARE_DELIVERY_SOURCE_LIMITS.projectedSnapshotBytes}.`,
    );
  }
  return {
    projectorId: SOFTWARE_DELIVERY_PROJECTOR_ID,
    snapshot,
  };
}
