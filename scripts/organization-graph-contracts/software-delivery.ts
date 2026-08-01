import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { format } from 'prettier';
import { canonicalJson } from '../../packages/organization-graph/src/canonical-json.js';
import {
  GRAPH_CONTRACT_ERROR_CODES,
  GraphContractError,
} from '../../packages/organization-graph/src/errors.js';
import { projectSoftwareDeliverySnapshot } from '../../packages/organization-graph/src/software-delivery-projector.js';
import {
  SOFTWARE_DELIVERY_PROJECTOR_CONTRACT,
  SOFTWARE_DELIVERY_PROJECTOR_ID,
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
  SOFTWARE_DELIVERY_SOURCE_SCHEMA,
} from '../../packages/organization-graph/src/software-delivery-types.js';
import type {
  SoftwareDeliveryEvidence,
  SoftwareDeliveryObservedBatch,
  SoftwareDeliveryObservationSource,
  SoftwareDeliverySourceSnapshot,
} from '../../packages/organization-graph/src/software-delivery-types.js';
import { serializeGraphSnapshot } from '../../packages/organization-graph/src/integrity.js';
import { validateSoftwareDeliverySourceSnapshot } from '../../packages/organization-graph/src/software-delivery-validation.js';
import {
  parseStrictGraphJson,
  STRICT_GRAPH_JSON_ERROR_CODES,
} from '../../packages/organization-graph/src/strict-json.js';

type JsonRecord = Record<string, unknown>;

export interface SoftwareDeliveryContractArtifacts {
  readonly schemaBytes: Buffer;
  readonly vectorBytes: Buffer;
  readonly manifestBytes: Buffer;
}

interface ProjectorVector {
  readonly id: string;
  readonly family:
    | 'complete'
    | 'historical'
    | 'all_missing'
    | 'incomplete_synthetic'
    | 'randomized_valid'
    | 'boundary_valid'
    | 'utf16'
    | 'ordering'
    | 'authority_boundary'
    | 'incomplete_truncation'
    | 'aggregate_boundary'
    | 'invalid';
  readonly operation: 'validate_and_project';
  readonly sourceSchemaValid: boolean;
  readonly input: { readonly source: unknown };
  readonly expected?: unknown;
  readonly expectedError?: JsonRecord;
}

const OBSERVED_AT = '2026-07-27T01:00:00.000Z';
const RANDOM_SEED = 0x5d02a11c;
const RANDOM_CASE_COUNT = 16;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const DATE_TIME_PATTERN =
  '^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$';
const HISTORICAL_FIXTURE_URL = new URL(
  '../../packages/organization-graph/src/__tests__/fixtures/software-delivery-source.json',
  import.meta.url,
);

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function prettyJson(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(JSON.stringify(value), {
      parser: 'json',
      printWidth: 100,
      tabWidth: 2,
    }),
    'utf8',
  );
}

function bytesContract(bytes: Buffer): JsonRecord {
  return {
    utf8Base64: bytes.toString('base64'),
    byteLength: bytes.length,
    sha256: sha256(bytes),
  };
}

function errorContract(run: () => unknown): JsonRecord {
  try {
    run();
  } catch (error) {
    if (error instanceof GraphContractError) {
      return {
        name: error.name,
        code: error.code,
        message: error.message,
        path: error.path,
      };
    }
    throw error;
  }
  throw new Error('Software Delivery error vector unexpectedly succeeded.');
}

function evidence(
  id: string,
  observationKind: SoftwareDeliveryEvidence['observationKind'],
): SoftwareDeliveryEvidence {
  return {
    id,
    authorityVersion: `version-${id}`,
    observationKind,
    observedAt: OBSERVED_AT,
    sourceEventIds: [`event-${id}`],
    evidenceRefs: [`evidence-${id}`],
  };
}

function observed<T>(name: string, items: T[]): SoftwareDeliveryObservedBatch<T> {
  return {
    status: 'observed',
    batchVersion: `batch-${name}-v1`,
    observedAt: OBSERVED_AT,
    items,
    warningCodes: [],
  };
}

function completeSource(): SoftwareDeliverySourceSnapshot {
  return {
    schema: SOFTWARE_DELIVERY_SOURCE_SCHEMA,
    scenarioDefinitionId: 'software-delivery',
    scenarioInstanceId: 'scenario-delivery-001',
    cursor: 'source-cursor-001',
    generatedAt: '2026-07-27T02:00:00.000Z',
    projectorVersion: SOFTWARE_DELIVERY_PROJECTOR_ID,
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

function allMissingSource(): SoftwareDeliverySourceSnapshot {
  const missing = () => ({
    status: 'missing' as const,
    items: [] as [],
    reasonCode: 'golden-not-observed',
  });
  return {
    schema: SOFTWARE_DELIVERY_SOURCE_SCHEMA,
    scenarioDefinitionId: 'software-delivery',
    scenarioInstanceId: 'scenario-delivery-all-missing',
    cursor: 'source-cursor-all-missing',
    generatedAt: '2026-07-27T02:00:00.000Z',
    projectorVersion: SOFTWARE_DELIVERY_PROJECTOR_ID,
    sources: {
      repository: missing(),
      actors: missing(),
      issues: missing(),
      claims: missing(),
      worktrees: missing(),
      commits: missing(),
      pullRequests: missing(),
      checks: missing(),
      reviews: missing(),
      merges: missing(),
      workflowRuns: missing(),
      agentRuns: missing(),
      prmsReports: missing(),
      handoffs: missing(),
      decisions: missing(),
    },
  };
}

function incompleteSyntheticSource(): SoftwareDeliverySourceSnapshot {
  const source = completeSource();
  source.scenarioInstanceId = 'scenario-delivery-incomplete-synthetic';
  source.cursor = 'source-cursor-incomplete-synthetic';
  source.sources.issues = {
    ...source.sources.issues,
    status: 'incomplete',
    warningCodes: ['partial-page'],
  };
  source.sources.issues.items[0]!.observationKind = 'synthetic';
  source.sources.pullRequests.items[0]!.observationKind = 'cache';
  source.sources.reviews = {
    status: 'incomplete',
    items: source.sources.reviews.items.map((review) => ({
      ...review,
      observationKind: 'synthetic' as const,
    })),
    warningCodes: ['review-authority-unavailable'],
  };
  source.sources.prmsReports.items[0]!.observationKind = 'synthetic';
  source.sources.merges.items[0]!.observationKind = 'synthetic';
  return source;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function select<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function randomizedSources(): SoftwareDeliverySourceSnapshot[] {
  const random = mulberry32(RANDOM_SEED);
  const sources: SoftwareDeliverySourceSnapshot[] = [];
  for (let index = 0; index < RANDOM_CASE_COUNT; index += 1) {
    const source = completeSource();
    const suffix = String(index).padStart(2, '0');
    source.scenarioInstanceId = `scenario-delivery-random-${suffix}`;
    source.cursor = `source-cursor-random-${suffix}`;
    const issue = source.sources.issues.items[0]!;
    issue.title = `Seeded delivery case ${suffix}-${Math.floor(random() * 1_000_000)}`;
    issue.assigneesComplete = random() >= 0.25;
    issue.closureComplete = random() >= 0.25;
    if (random() < 0.35) {
      issue.state = 'open';
      issue.closureComplete = false;
      delete issue.closedAt;
    }
    source.sources.claims.items[0]!.status = select(random, [
      'active',
      'expired',
      'released',
    ] as const);
    source.sources.pullRequests.items[0]!.state = select(random, [
      'open',
      'closed',
      'merged',
    ] as const);
    const check = source.sources.checks.items[0]!;
    check.status = select(random, ['queued', 'in_progress', 'completed'] as const);
    if (check.status === 'completed') {
      check.conclusion = select(random, [
        'success',
        'failure',
        'neutral',
        'cancelled',
        'skipped',
      ] as const);
      check.completedAt = '2026-07-27T00:50:00.000Z';
    } else {
      delete check.conclusion;
      delete check.completedAt;
    }
    source.sources.reviews.items[0]!.state = select(random, [
      'APPROVED',
      'CHANGES_REQUESTED',
      'COMMENTED',
      'DISMISSED',
    ] as const);
    const workflow = source.sources.workflowRuns.items[0]!;
    workflow.status = select(random, ['running', 'paused', 'completed', 'failed'] as const);
    if (workflow.status === 'completed' || workflow.status === 'failed') {
      workflow.completedAt = '2026-07-27T01:35:00.000Z';
    } else {
      delete workflow.completedAt;
    }
    const agentRun = source.sources.agentRuns.items[0]!;
    agentRun.status = select(random, ['running', 'paused', 'completed', 'failed'] as const);
    if (agentRun.status === 'completed' || agentRun.status === 'failed') {
      agentRun.completedAt = '2026-07-27T01:20:00.000Z';
    } else {
      delete agentRun.completedAt;
    }
    const prms = source.sources.prmsReports.items[0]!;
    prms.status = select(random, ['ready', 'blocked', 'needs_human_approval', 'failed'] as const);
    prms.blockerCount = prms.status === 'ready' ? 0 : Math.floor(random() * 4) + 1;
    const handoff = source.sources.handoffs.items[0]!;
    handoff.status = select(random, ['open', 'accepted', 'closed'] as const);
    if (handoff.status === 'closed') handoff.closedAt = '2026-07-27T01:10:00.000Z';
    else delete handoff.closedAt;
    const decision = source.sources.decisions.items[0]!;
    decision.status = select(random, ['active', 'superseded'] as const);
    if (decision.status === 'superseded') {
      decision.supersededAt = '2026-07-27T01:20:00.000Z';
    } else {
      delete decision.supersededAt;
    }
    const observationKind = select<SoftwareDeliveryObservationSource>(random, [
      'live',
      'cache',
      'synthetic',
    ]);
    source.sources.commits.items[0]!.observationKind = observationKind;
    if (random() < 0.3) source.sources.checks.items[0]!.headSha = 'stale-random-head';
    if (random() < 0.3) delete source.sources.prmsReports.items[0]!.headSha;
    sources.push(source);
  }
  return sources;
}

function withCommitSha(
  sha: string,
  scenarioInstanceId: string,
  cursor: string,
): SoftwareDeliverySourceSnapshot {
  const source = completeSource();
  source.scenarioInstanceId = scenarioInstanceId;
  source.cursor = cursor;
  source.sources.commits.items[0]!.sha = sha;
  source.sources.pullRequests.items[0]!.commitShas = [sha];
  return source;
}

function multiRecordOrderingSources(): readonly [
  SoftwareDeliverySourceSnapshot,
  SoftwareDeliverySourceSnapshot,
] {
  const source = completeSource();
  source.scenarioInstanceId = 'scenario-delivery-ordering';
  source.cursor = 'source-cursor-ordering';

  const issueBatch = source.sources.issues;
  const commitBatch = source.sources.commits;
  if (issueBatch.status !== 'observed' || commitBatch.status !== 'observed') {
    throw new Error('Complete Software Delivery fixture must observe issues and commits.');
  }
  const issueTemplate = issueBatch.items[0]!;
  const secondIssue = {
    ...issueTemplate,
    id: 'issue-2',
    authorityVersion: 'version-issue-2',
    number: 2,
    title: 'Second ordered issue',
    state: 'open' as const,
    labels: [
      { name: 'beta', category: 'other' as const },
      { name: 'alpha', category: 'other' as const },
    ],
    assigneeIds: ['reviewer-1', 'agent-1'],
    closureComplete: false,
    sourceEventIds: ['event-issue-2'],
    evidenceRefs: ['evidence-issue-2'],
  };
  delete (secondIssue as { closedAt?: string }).closedAt;
  issueBatch.items.push(secondIssue);

  const commitTemplate = commitBatch.items[0]!;
  const secondCommit = {
    ...commitTemplate,
    id: 'commit-observation-2',
    authorityVersion: 'version-commit-observation-2',
    sha: 'head-sha-2',
    issueIds: ['issue-2', 'issue-10'],
    sourceEventIds: ['event-commit-observation-2'],
    evidenceRefs: ['evidence-commit-observation-2'],
  };
  commitBatch.items.push(secondCommit);
  source.sources.pullRequests.items[0]!.issueIds = ['issue-10', 'issue-2'];
  source.sources.pullRequests.items[0]!.commitShas = ['head-sha-1', 'head-sha-2'];

  const permuted = structuredClone(source);
  for (const batch of Object.values(permuted.sources)) batch.items.reverse();
  for (const issue of permuted.sources.issues.items) {
    issue.labels.reverse();
    issue.assigneeIds.reverse();
  }
  for (const commit of permuted.sources.commits.items) commit.issueIds.reverse();
  for (const pullRequest of permuted.sources.pullRequests.items) {
    pullRequest.issueIds.reverse();
    pullRequest.commitShas.reverse();
  }
  return [source, permuted];
}

function sameMillisecondReviewSemanticDuplicateSource(): SoftwareDeliverySourceSnapshot {
  const source = completeSource();
  source.scenarioInstanceId = 'scenario-delivery-review-semantic-duplicate';
  source.cursor = 'source-cursor-review-semantic-duplicate';
  const reviewBatch = source.sources.reviews;
  if (reviewBatch.status !== 'observed') {
    throw new Error('Complete Software Delivery fixture must observe reviews.');
  }
  const first = reviewBatch.items[0]!;
  first.submittedAt = '2026-07-27T01:00:00.0001Z';
  const duplicate = {
    ...first,
    id: 'review-same-millisecond-duplicate',
    authorityVersion: 'version-review-same-millisecond-duplicate',
    submittedAt: '2026-07-27T01:00:00.0009Z',
    sourceEventIds: ['event-review-same-millisecond-duplicate'],
    evidenceRefs: ['evidence-review-same-millisecond-duplicate'],
  };
  reviewBatch.items.push(duplicate);
  if (
    Date.parse(first.submittedAt) !== Date.parse(duplicate.submittedAt) ||
    first.pullRequestId !== duplicate.pullRequestId ||
    first.actorId !== duplicate.actorId ||
    first.commitOid !== duplicate.commitOid
  ) {
    throw new Error('Review duplicate fixture must share one semantic decision group.');
  }
  return source;
}

function elapsedActiveClaimSource(): SoftwareDeliverySourceSnapshot {
  const source = completeSource();
  source.scenarioInstanceId = 'scenario-delivery-elapsed-active-claim';
  source.cursor = 'source-cursor-elapsed-active-claim';
  source.sources.claims.items[0]!.expiresAt = source.generatedAt;
  return source;
}

function incompleteTruncationSource(): SoftwareDeliverySourceSnapshot {
  const source = completeSource();
  source.scenarioInstanceId = 'scenario-delivery-incomplete-truncation';
  source.cursor = 'source-cursor-incomplete-truncation';
  delete source.sources.pullRequests.items[0]!.baseSha;
  delete source.sources.pullRequests.items[0]!.headSha;
  source.sources.pullRequests.items[0]!.commitShas = ['missing-commit'];
  delete source.sources.claims.items[0]!.targetSha;
  source.sources.claims.items[0]!.issueId = 'missing-claim-issue';
  delete source.sources.worktrees.items[0]!.baseSha;
  source.sources.worktrees.items[0]!.claimId = 'missing-claim';
  source.sources.worktrees.items[0]!.agentRunId = 'missing-agent-run';
  delete source.sources.checks.items[0]!.headSha;
  delete source.sources.merges.items[0]!.headSha;
  delete source.sources.prmsReports.items[0]!.baseSha;
  delete source.sources.prmsReports.items[0]!.headSha;
  source.sources.handoffs.items[0]!.issueId = 'missing-handoff-issue';
  source.sources.decisions.items[0]!.workflowRunId = 'missing-workflow-run';

  const commitTemplate = source.sources.commits.items[0]!;
  source.sources.commits.items = Array.from({ length: 30 }, (_, index) => ({
    ...commitTemplate,
    id: `dangling-commit-${index}`,
    authorityVersion: `version-dangling-commit-${index}`,
    sha: `dangling-sha-${index}`,
    issueIds: [`missing-issue-${index}`],
    worktreeId: `missing-worktree-${index}`,
    sourceEventIds: [`event-dangling-commit-${index}`],
    evidenceRefs: [`evidence-dangling-commit-${index}`],
  }));
  return source;
}

function clearSourceItems(source: SoftwareDeliverySourceSnapshot): void {
  source.sources.repository.items = [];
  source.sources.actors.items = [];
  source.sources.issues.items = [];
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
}

function aggregateRelationBoundarySource(overBy: 0 | 1): SoftwareDeliverySourceSnapshot {
  const source = completeSource();
  const issueTemplate = source.sources.issues.items[0]!;
  source.scenarioInstanceId =
    overBy === 0
      ? 'scenario-delivery-aggregate-relations-exact'
      : 'scenario-delivery-aggregate-relations-over';
  source.cursor =
    overBy === 0
      ? 'source-cursor-aggregate-relations-exact'
      : 'source-cursor-aggregate-relations-over';
  clearSourceItems(source);
  source.sources.issues.items = Array.from({ length: 240 }, (_, issueIndex) => {
    const issue = {
      ...issueTemplate,
      id: `aggregate-issue-${issueIndex}`,
      authorityVersion: `aggregate-issue-version-${issueIndex}`,
      number: issueIndex + 1,
      title: `Aggregate issue ${issueIndex}`,
      state: 'open' as const,
      labels: [],
      assigneeIds: Array.from(
        { length: 49 + Number(overBy === 1 && issueIndex === 0) },
        (_, actorIndex) => `a${issueIndex}-${actorIndex}`,
      ),
      assigneesComplete: true,
      closureComplete: false,
      sourceEventIds: [`aggregate-issue-event-${issueIndex}`],
      evidenceRefs: [`aggregate-issue-evidence-${issueIndex}`],
    };
    delete (issue as { closedAt?: string }).closedAt;
    return issue;
  });
  return source;
}

function projectionExpectation(source: SoftwareDeliverySourceSnapshot): JsonRecord {
  const result = projectSoftwareDeliverySnapshot(source);
  const serialized = serializeGraphSnapshot(result.snapshot);
  return {
    projectorId: result.projectorId,
    snapshot: result.snapshot,
    canonicalSnapshotBytes: bytesContract(serialized),
    integrityHash: result.snapshot.integrityHash,
    nodeIds: result.snapshot.nodes.map((node) => node.id),
    edgeIds: result.snapshot.edges.map((edge) => edge.id),
    completeness: result.snapshot.completeness,
    warnings: result.snapshot.completeness.warnings,
  };
}

function validVector(
  id: string,
  family: Exclude<ProjectorVector['family'], 'invalid'>,
  source: SoftwareDeliverySourceSnapshot,
): ProjectorVector {
  return {
    id,
    family,
    operation: 'validate_and_project',
    sourceSchemaValid: true,
    input: { source },
    expected: projectionExpectation(source),
  };
}

function invalidVector(id: string, source: unknown, sourceSchemaValid = false): ProjectorVector {
  return {
    id,
    family: 'invalid',
    operation: 'validate_and_project',
    sourceSchemaValid,
    input: { source },
    expectedError: errorContract(() => projectSoftwareDeliverySnapshot(source)),
  };
}

function buildVectors(
  historicalSource: SoftwareDeliverySourceSnapshot,
): readonly ProjectorVector[] {
  const boundary = completeSource();
  boundary.scenarioInstanceId = 'scenario-delivery-boundary-valid';
  boundary.cursor = 'source-cursor-boundary-valid';
  boundary.sources.issues.items[0]!.evidenceRefs = [
    'e'.repeat(SOFTWARE_DELIVERY_SOURCE_LIMITS.textBytes),
  ];
  boundary.sources.issues.items[0]!.number = MAX_SAFE_INTEGER;

  const unexpected = { ...completeSource(), unexpected: true };
  const compoundUnexpected = {
    ...completeSource(),
    zUnexpected: true,
    aUnexpected: true,
  };
  const missingAuthorityVersion = completeSource();
  delete (missingAuthorityVersion.sources.issues.items[0] as { authorityVersion?: string })
    .authorityVersion;
  const incompleteWithoutWarning = completeSource();
  incompleteWithoutWarning.sources.reviews = {
    status: 'incomplete',
    items: [],
    warningCodes: [],
  };
  const missingWithItem = completeSource();
  missingWithItem.sources.merges = {
    status: 'missing',
    items: missingWithItem.sources.merges.items,
    reasonCode: 'unavailable',
  } as never;
  const duplicateIssue = completeSource();
  const duplicateIssueBatch = duplicateIssue.sources.issues;
  if (duplicateIssueBatch.status !== 'observed') {
    throw new Error('Complete Software Delivery fixture must observe issues.');
  }
  duplicateIssueBatch.items.push({
    ...duplicateIssueBatch.items[0]!,
    id: 'issue-alias-10',
    authorityVersion: 'version-issue-alias-10',
    sourceEventIds: ['event-issue-alias-10'],
    evidenceRefs: ['evidence-issue-alias-10'],
  });
  const invalidDate = completeSource();
  invalidDate.generatedAt = '2026-07-27T02:00:00+24:00';
  const incompleteCheck = completeSource();
  delete incompleteCheck.sources.checks.items[0]!.conclusion;
  const overEvidenceReference = completeSource();
  overEvidenceReference.sources.issues.items[0]!.evidenceRefs = [
    'e'.repeat(SOFTWARE_DELIVERY_SOURCE_LIMITS.textBytes + 1),
  ];
  const overLabels = completeSource();
  overLabels.sources.issues.items[0]!.labels = Array.from(
    { length: SOFTWARE_DELIVERY_SOURCE_LIMITS.labelsPerIssue + 1 },
    (_, index) => ({ name: `label-${index}`, category: 'other' as const }),
  );
  const overRelations = completeSource();
  overRelations.sources.commits.items[0]!.issueIds = Array.from(
    { length: SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation + 1 },
    (_, index) => `issue-${index}`,
  );
  const wrongProjector = completeSource();
  wrongProjector.projectorVersion = 'openslack.software_delivery.v2';

  const bmpCommit = withCommitSha(
    '提交版本甲乙丙丁戊己庚辛壬癸子丑寅',
    'scenario-delivery-utf16-bmp',
    'source-cursor-utf16-bmp',
  );
  const splitSurrogateCommit = withCommitSha(
    `${'a'.repeat(11)}😀tail`,
    'scenario-delivery-utf16-split-surrogate',
    'source-cursor-utf16-split-surrogate',
  );
  const [multiRecordOrdering, permutedMultiRecordOrdering] = multiRecordOrderingSources();
  const orderingExpected = projectionExpectation(multiRecordOrdering);
  const permutedOrderingExpected = projectionExpectation(permutedMultiRecordOrdering);
  if (canonicalJson(orderingExpected) !== canonicalJson(permutedOrderingExpected)) {
    throw new Error('Software Delivery ordering fixtures must project to identical bytes.');
  }
  const reviewTie = sameMillisecondReviewSemanticDuplicateSource();
  const elapsedClaim = elapsedActiveClaimSource();
  const incompleteTruncation = incompleteTruncationSource();
  const incompleteProjection = projectSoftwareDeliverySnapshot(incompleteTruncation).snapshot;
  if (
    !incompleteProjection.completeness.missingSources.includes(
      'projection.missing-sources.truncated',
    ) ||
    !incompleteProjection.completeness.warnings.includes('projection.warnings.truncated')
  ) {
    throw new Error('Software Delivery incomplete fixture must exercise completeness truncation.');
  }
  const aggregateRelationsExact = aggregateRelationBoundarySource(0);
  const aggregateRelationsOver = aggregateRelationBoundarySource(1);

  const vectors: ProjectorVector[] = [
    validVector('projector-complete-existing-chain', 'complete', completeSource()),
    validVector('projector-historical-repository-fixture', 'historical', historicalSource),
    validVector('projector-all-sources-missing', 'all_missing', allMissingSource()),
    validVector(
      'projector-incomplete-synthetic-authority',
      'incomplete_synthetic',
      incompleteSyntheticSource(),
    ),
    validVector('projector-boundary-valid', 'boundary_valid', boundary),
    validVector('projector-utf16-bmp-commit-title', 'utf16', bmpCommit),
    validVector('projector-multi-record-ordering', 'ordering', multiRecordOrdering),
    validVector(
      'projector-multi-record-ordering-permuted',
      'ordering',
      permutedMultiRecordOrdering,
    ),
    validVector(
      'projector-active-claim-expires-at-generated-at',
      'authority_boundary',
      elapsedClaim,
    ),
    validVector(
      'projector-missing-bindings-dangling-completeness-truncation',
      'incomplete_truncation',
      incompleteTruncation,
    ),
    validVector(
      'projector-aggregate-relations-exact-limit',
      'aggregate_boundary',
      aggregateRelationsExact,
    ),
    ...randomizedSources().map((source, index) =>
      validVector(
        `projector-randomized-valid-${String(index).padStart(2, '0')}`,
        'randomized_valid',
        source,
      ),
    ),
    invalidVector('projector-invalid-unexpected-root-property', unexpected),
    invalidVector('projector-invalid-unexpected-key-utf16-order', compoundUnexpected),
    invalidVector('projector-invalid-missing-authority-version', missingAuthorityVersion),
    invalidVector('projector-invalid-incomplete-without-warning', incompleteWithoutWarning),
    invalidVector('projector-invalid-missing-batch-with-item', missingWithItem),
    invalidVector('projector-invalid-duplicate-semantic-issue', duplicateIssue, true),
    invalidVector('projector-invalid-date-offset-boundary', invalidDate),
    invalidVector('projector-invalid-completed-check-without-conclusion', incompleteCheck),
    invalidVector('projector-invalid-evidence-ref-over-bound', overEvidenceReference),
    invalidVector('projector-invalid-labels-over-bound', overLabels),
    invalidVector('projector-invalid-relations-over-bound', overRelations),
    invalidVector('projector-invalid-projector-version', wrongProjector),
    invalidVector('projector-invalid-review-date-parse-millisecond-tie', reviewTie, true),
    invalidVector('projector-invalid-utf16-split-surrogate-title', splitSurrogateCommit, true),
    invalidVector('projector-invalid-aggregate-relations-over-limit', aggregateRelationsOver, true),
  ];

  const ids = new Set<string>();
  for (const vector of vectors) {
    if (ids.has(vector.id))
      throw new Error(`Software Delivery vector ID ${vector.id} is duplicated.`);
    ids.add(vector.id);
    const actual = replayProjectorVector(vector);
    const expected = vector.expected ?? vector.expectedError;
    if (expected === undefined || canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error(`Software Delivery vector ${vector.id} is not replayable.`);
    }
  }
  return vectors;
}

function replayProjectorVector(vector: ProjectorVector): unknown {
  if (vector.family === 'invalid') {
    return errorContract(() => projectSoftwareDeliverySnapshot(vector.input.source));
  }
  return projectionExpectation(vector.input.source as SoftwareDeliverySourceSnapshot);
}

function vectorInventory(vectors: readonly ProjectorVector[]): JsonRecord {
  const families: Record<string, number> = {};
  for (const family of [...new Set(vectors.map((vector) => vector.family))].sort(compareUtf16)) {
    families[family] = vectors.filter((vector) => vector.family === family).length;
  }
  return {
    total: vectors.length,
    success: vectors.filter((vector) => vector.expected !== undefined).length,
    error: vectors.filter((vector) => vector.expectedError !== undefined).length,
    schemaValid: vectors.filter((vector) => vector.sourceSchemaValid).length,
    schemaInvalid: vectors.filter((vector) => !vector.sourceSchemaValid).length,
    families,
    random: RANDOM_CASE_COUNT,
  };
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
  extras: Readonly<Record<string, unknown>> = {},
): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
    ...extras,
  };
}

function buildSourceSchema(): JsonRecord {
  const identifier = { type: 'string', minLength: 1, maxLength: 2_048, pattern: '^\\S+$' };
  const text = {
    type: 'string',
    minLength: 1,
    maxLength: SOFTWARE_DELIVERY_SOURCE_LIMITS.textBytes,
  };
  const dateTime = {
    type: 'string',
    minLength: 1,
    maxLength: 64,
    pattern: DATE_TIME_PATTERN,
  };
  const referenceArray = (maxItems: number): JsonRecord => ({
    type: 'array',
    maxItems,
    uniqueItems: true,
    items: identifier,
  });
  const evidenceProperties = {
    id: identifier,
    authorityVersion: identifier,
    observationKind: { enum: ['live', 'local_store', 'cache', 'synthetic'] },
    observedAt: dateTime,
    sourceEventIds: referenceArray(50),
    evidenceRefs: referenceArray(50),
  };
  const evidenceRequired = [
    'id',
    'authorityVersion',
    'observationKind',
    'observedAt',
    'sourceEventIds',
    'evidenceRefs',
  ];
  const observation = (
    properties: Readonly<Record<string, unknown>>,
    required: readonly string[],
    extras: Readonly<Record<string, unknown>> = {},
  ): JsonRecord =>
    objectSchema(
      { ...evidenceProperties, ...properties },
      [...evidenceRequired, ...required],
      extras,
    );
  const terminalStatusRules = (terminal: readonly string[]): JsonRecord => ({
    allOf: [
      {
        if: { properties: { status: { enum: terminal } }, required: ['status'] },
        then: { properties: { completedAt: true }, required: ['completedAt'] },
        else: { not: { properties: { completedAt: true }, required: ['completedAt'] } },
      },
    ],
  });
  const definitions: Record<string, unknown> = {
    repositoryObservation: observation(
      { repositoryId: identifier, fullName: identifier, defaultBranch: identifier },
      ['repositoryId', 'fullName', 'defaultBranch'],
    ),
    actorObservation: observation(
      {
        authorityProvider: { enum: ['github', 'openslack'] },
        actor: objectSchema(
          {
            id: identifier,
            kind: { enum: ['human', 'agent', 'system'] },
            displayName: { type: 'string', minLength: 1, maxLength: 512 },
          },
          ['id', 'kind'],
        ),
      },
      ['authorityProvider', 'actor'],
    ),
    issueObservation: observation(
      {
        repositoryId: identifier,
        number: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
        title: text,
        state: { enum: ['open', 'closed'] },
        labels: {
          type: 'array',
          maxItems: SOFTWARE_DELIVERY_SOURCE_LIMITS.labelsPerIssue,
          items: objectSchema(
            {
              name: { type: 'string', minLength: 1, maxLength: 256 },
              category: { enum: ['state', 'risk', 'capability', 'other'] },
            },
            ['name', 'category'],
          ),
        },
        assigneeIds: referenceArray(50),
        assigneesComplete: { type: 'boolean' },
        closureComplete: { type: 'boolean' },
        createdAt: dateTime,
        updatedAt: dateTime,
        closedAt: dateTime,
      },
      [
        'repositoryId',
        'number',
        'title',
        'state',
        'labels',
        'assigneeIds',
        'assigneesComplete',
        'closureComplete',
        'createdAt',
        'updatedAt',
      ],
      {
        allOf: [
          {
            if: { properties: { state: { const: 'open' } }, required: ['state'] },
            then: { not: { properties: { closedAt: true }, required: ['closedAt'] } },
          },
          {
            if: {
              properties: { state: { const: 'closed' }, closureComplete: { const: true } },
              required: ['state', 'closureComplete'],
            },
            then: { properties: { closedAt: true }, required: ['closedAt'] },
          },
        ],
      },
    ),
    claimObservation: observation(
      {
        issueId: identifier,
        claimRef: identifier,
        targetSha: identifier,
        status: { enum: ['active', 'expired', 'released'] },
        agentActorId: identifier,
        claimedAt: dateTime,
        expiresAt: dateTime,
      },
      ['issueId', 'claimRef', 'status', 'agentActorId', 'claimedAt', 'expiresAt'],
    ),
    worktreeObservation: observation(
      {
        issueId: identifier,
        claimId: identifier,
        agentRunId: identifier,
        worktreeId: identifier,
        baseSha: identifier,
        branchName: identifier,
        status: { enum: ['active', 'preserved', 'cleaned'] },
        createdAt: dateTime,
        closedAt: dateTime,
      },
      ['issueId', 'worktreeId', 'branchName', 'status', 'createdAt'],
      {
        allOf: [
          {
            if: { properties: { status: { const: 'cleaned' } }, required: ['status'] },
            then: { properties: { closedAt: true }, required: ['closedAt'] },
          },
          {
            if: { properties: { status: { const: 'active' } }, required: ['status'] },
            then: { not: { properties: { closedAt: true }, required: ['closedAt'] } },
          },
        ],
      },
    ),
    commitObservation: observation(
      {
        repositoryId: identifier,
        sha: identifier,
        issueIds: referenceArray(SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation),
        worktreeId: identifier,
        authoredAt: dateTime,
      },
      ['repositoryId', 'sha', 'issueIds', 'authoredAt'],
    ),
    pullRequestObservation: observation(
      {
        repositoryId: identifier,
        number: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
        title: text,
        authorActorId: identifier,
        state: { enum: ['open', 'closed', 'merged'] },
        draft: { type: 'boolean' },
        baseSha: identifier,
        headSha: identifier,
        issueIds: referenceArray(SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation),
        commitShas: referenceArray(SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation),
        openedAt: dateTime,
        updatedAt: dateTime,
      },
      [
        'repositoryId',
        'number',
        'title',
        'authorActorId',
        'state',
        'draft',
        'issueIds',
        'commitShas',
        'openedAt',
        'updatedAt',
      ],
    ),
    checkObservation: observation(
      {
        pullRequestId: identifier,
        name: { type: 'string', minLength: 1, maxLength: 512 },
        status: { enum: ['queued', 'in_progress', 'completed'] },
        conclusion: {
          enum: [
            'success',
            'failure',
            'neutral',
            'cancelled',
            'skipped',
            'timed_out',
            'action_required',
            'stale',
            'startup_failure',
          ],
        },
        headSha: identifier,
        startedAt: dateTime,
        completedAt: dateTime,
      },
      ['pullRequestId', 'name', 'status', 'startedAt'],
      {
        allOf: [
          {
            if: { properties: { status: { const: 'completed' } }, required: ['status'] },
            then: {
              properties: { conclusion: true, completedAt: true },
              required: ['conclusion', 'completedAt'],
            },
            else: {
              allOf: [
                { not: { properties: { conclusion: true }, required: ['conclusion'] } },
                { not: { properties: { completedAt: true }, required: ['completedAt'] } },
              ],
            },
          },
        ],
      },
    ),
    reviewObservation: observation(
      {
        pullRequestId: identifier,
        actorId: identifier,
        actorKind: { enum: ['human', 'agent', 'system'] },
        state: { enum: ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'] },
        commitOid: identifier,
        submittedAt: dateTime,
      },
      ['pullRequestId', 'actorId', 'actorKind', 'state', 'submittedAt'],
    ),
    mergeObservation: observation(
      {
        pullRequestId: identifier,
        headSha: identifier,
        mergeCommitSha: identifier,
        actorId: identifier,
        mergedAt: dateTime,
      },
      ['pullRequestId', 'actorId', 'mergedAt'],
    ),
    workflowRunObservation: observation(
      {
        workflowId: identifier,
        status: {
          enum: [
            'created',
            'previewed',
            'confirmed',
            'pending',
            'running',
            'paused',
            'paused_waiting_approval',
            'resuming',
            'completed',
            'failed',
            'cancelled',
          ],
        },
        issueIds: referenceArray(SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation),
        pullRequestIds: referenceArray(SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation),
        startedAt: dateTime,
        completedAt: dateTime,
      },
      ['workflowId', 'status', 'issueIds', 'pullRequestIds', 'startedAt'],
      terminalStatusRules(['completed', 'failed', 'cancelled']),
    ),
    agentRunObservation: observation(
      {
        workflowRunId: identifier,
        agentActorId: identifier,
        status: { enum: ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'] },
        worktreeId: identifier,
        startedAt: dateTime,
        completedAt: dateTime,
      },
      ['agentActorId', 'status', 'startedAt'],
      terminalStatusRules(['completed', 'failed', 'cancelled']),
    ),
    prmsReportObservation: observation(
      {
        pullRequestId: identifier,
        baseSha: identifier,
        headSha: identifier,
        status: { enum: ['ready', 'blocked', 'needs_human_approval', 'failed'] },
        blockerCount: { type: 'integer', minimum: 0, maximum: MAX_SAFE_INTEGER },
      },
      ['pullRequestId', 'status', 'blockerCount'],
      {
        allOf: [
          {
            if: { properties: { status: { const: 'ready' } }, required: ['status'] },
            then: { properties: { blockerCount: { const: 0 } } },
          },
        ],
      },
    ),
    handoffObservation: observation(
      {
        status: { enum: ['open', 'accepted', 'closed'] },
        fromActorId: identifier,
        toActorId: identifier,
        issueId: identifier,
        pullRequestId: identifier,
        workflowRunId: identifier,
        createdAt: dateTime,
        closedAt: dateTime,
      },
      ['status', 'fromActorId', 'toActorId', 'createdAt'],
      {
        allOf: [
          {
            if: { properties: { status: { const: 'closed' } }, required: ['status'] },
            then: { properties: { closedAt: true }, required: ['closedAt'] },
            else: { not: { properties: { closedAt: true }, required: ['closedAt'] } },
          },
        ],
      },
    ),
    decisionObservation: observation(
      {
        topic: text,
        status: { enum: ['active', 'superseded'] },
        decidedByActorId: identifier,
        issueId: identifier,
        pullRequestId: identifier,
        workflowRunId: identifier,
        createdAt: dateTime,
        supersededAt: dateTime,
      },
      ['topic', 'status', 'decidedByActorId', 'createdAt'],
      {
        allOf: [
          {
            if: { properties: { status: { const: 'superseded' } }, required: ['status'] },
            then: { properties: { supersededAt: true }, required: ['supersededAt'] },
            else: {
              not: { properties: { supersededAt: true }, required: ['supersededAt'] },
            },
          },
        ],
      },
    ),
  };

  const batchSchema = (definition: string, maxItems = 500): JsonRecord => {
    const items = { type: 'array', maxItems, items: { $ref: `#/$defs/${definition}` } };
    const warningCodes = referenceArray(SOFTWARE_DELIVERY_SOURCE_LIMITS.completenessEntries);
    return {
      oneOf: [
        objectSchema(
          {
            status: { const: 'observed' },
            batchVersion: identifier,
            observedAt: dateTime,
            items,
            warningCodes,
          },
          ['status', 'batchVersion', 'observedAt', 'items', 'warningCodes'],
        ),
        objectSchema(
          {
            status: { const: 'incomplete' },
            batchVersion: identifier,
            observedAt: dateTime,
            items,
            warningCodes: { ...warningCodes, minItems: 1 },
          },
          ['status', 'batchVersion', 'observedAt', 'items', 'warningCodes'],
        ),
        objectSchema(
          {
            status: { const: 'incomplete' },
            items,
            warningCodes: { ...warningCodes, minItems: 1 },
          },
          ['status', 'items', 'warningCodes'],
        ),
        objectSchema(
          {
            status: { const: 'missing' },
            items: { type: 'array', maxItems: 0 },
            reasonCode: identifier,
          },
          ['status', 'items', 'reasonCode'],
        ),
      ],
    };
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openslack.dev/schemas/software-delivery-source-snapshot.v1.schema.json',
    title: 'OpenSlack Software Delivery Source Snapshot v1',
    description:
      'Closed structural schema for the bounded, injected Software Delivery projector source. TypeScript semantic validation remains authoritative.',
    type: 'object',
    additionalProperties: false,
    required: [
      'schema',
      'scenarioDefinitionId',
      'scenarioInstanceId',
      'cursor',
      'generatedAt',
      'projectorVersion',
      'sources',
    ],
    properties: {
      schema: { const: SOFTWARE_DELIVERY_SOURCE_SCHEMA },
      scenarioDefinitionId: identifier,
      scenarioInstanceId: identifier,
      cursor: identifier,
      generatedAt: dateTime,
      projectorVersion: { const: SOFTWARE_DELIVERY_PROJECTOR_ID },
      sources: objectSchema(
        {
          repository: batchSchema('repositoryObservation', 1),
          actors: batchSchema('actorObservation'),
          issues: batchSchema('issueObservation'),
          claims: batchSchema('claimObservation'),
          worktrees: batchSchema('worktreeObservation'),
          commits: batchSchema('commitObservation'),
          pullRequests: batchSchema('pullRequestObservation'),
          checks: batchSchema('checkObservation'),
          reviews: batchSchema('reviewObservation'),
          merges: batchSchema('mergeObservation'),
          workflowRuns: batchSchema('workflowRunObservation'),
          agentRuns: batchSchema('agentRunObservation'),
          prmsReports: batchSchema('prmsReportObservation'),
          handoffs: batchSchema('handoffObservation'),
          decisions: batchSchema('decisionObservation'),
        },
        [
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
        ],
      ),
    },
    $defs: definitions,
  };
}

export async function buildSoftwareDeliveryContractArtifacts(): Promise<SoftwareDeliveryContractArtifacts> {
  const historicalSource = validateSoftwareDeliverySourceSnapshot(
    parseStrictGraphJson(await readFile(HISTORICAL_FIXTURE_URL)),
  );
  const schemaBytes = await prettyJson(buildSourceSchema());
  const projectorVectors = buildVectors(historicalSource);
  const vectors = {
    schema: 'openslack.software_delivery_projector_golden_vectors.v1',
    authority: 'typescript',
    projectorId: SOFTWARE_DELIVERY_PROJECTOR_ID,
    sourceSchema: SOFTWARE_DELIVERY_SOURCE_SCHEMA,
    randomized: {
      algorithm: 'mulberry32.v1',
      seed: `0x${RANDOM_SEED.toString(16).padStart(8, '0')}`,
      cases: RANDOM_CASE_COUNT,
    },
    cases: projectorVectors,
  };
  const vectorBytes = await prettyJson(vectors);
  const manifest = {
    schema: 'openslack.software_delivery_projector_contract_manifest.v1',
    authority: 'typescript',
    sourceSchema: SOFTWARE_DELIVERY_SOURCE_SCHEMA,
    projectorId: SOFTWARE_DELIVERY_PROJECTOR_ID,
    graphSnapshotSchema: 'openslack.graph_snapshot.v1',
    sourceLimits: SOFTWARE_DELIVERY_SOURCE_LIMITS,
    projectorContract: SOFTWARE_DELIVERY_PROJECTOR_CONTRACT,
    algorithms: {
      validation: 'openslack.software_delivery_source_validation.v1',
      projection: SOFTWARE_DELIVERY_PROJECTOR_ID,
      canonicalSnapshot: 'openslack.ecmascript_canonical_json.v1+lf',
      nodeIdentity: 'openslack.graph_node_identity.sha256.v1',
      edgeIdentity: 'openslack.graph_edge_identity.sha256.v1',
      snapshotIntegrity: 'openslack.graph_snapshot_integrity.sha256.v1',
      randomizedCases: 'mulberry32.v1',
    },
    randomized: {
      seed: `0x${RANDOM_SEED.toString(16).padStart(8, '0')}`,
      cases: RANDOM_CASE_COUNT,
    },
    errorCodes: {
      graphContract: GRAPH_CONTRACT_ERROR_CODES,
      strictJson: STRICT_GRAPH_JSON_ERROR_CODES,
    },
    vectorInventory: vectorInventory(projectorVectors),
    artifacts: {
      sourceSchema: {
        path: 'schemas/software-delivery-source-snapshot.v1.schema.json',
        sha256: sha256(schemaBytes),
      },
      projectorGoldenVectors: {
        path: 'projector-golden-vectors.json',
        sha256: sha256(vectorBytes),
      },
    },
  };
  const manifestBytes = await prettyJson(manifest);
  return { schemaBytes, vectorBytes, manifestBytes };
}
