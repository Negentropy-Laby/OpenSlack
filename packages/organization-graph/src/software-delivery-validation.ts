import { GraphContractError } from './errors.js';
import { inertGraphJsonBytes } from './inert-json.js';
import {
  SOFTWARE_DELIVERY_PROJECTOR_ID,
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
  SOFTWARE_DELIVERY_SOURCE_SCHEMA,
} from './software-delivery-types.js';
import type {
  SoftwareDeliveryActorObservation,
  SoftwareDeliveryAgentRunObservation,
  SoftwareDeliveryCheckObservation,
  SoftwareDeliveryClaimObservation,
  SoftwareDeliveryCommitObservation,
  SoftwareDeliveryDecisionObservation,
  SoftwareDeliveryEvidence,
  SoftwareDeliveryHandoffObservation,
  SoftwareDeliveryIssueObservation,
  SoftwareDeliveryLabel,
  SoftwareDeliveryMergeObservation,
  SoftwareDeliveryObservationSource,
  SoftwareDeliveryPrmsReportObservation,
  SoftwareDeliveryPullRequestObservation,
  SoftwareDeliveryRepositoryObservation,
  SoftwareDeliveryReviewObservation,
  SoftwareDeliverySourceBatch,
  SoftwareDeliverySourceBatches,
  SoftwareDeliverySourceSnapshot,
  SoftwareDeliveryWorkflowRunObservation,
  SoftwareDeliveryWorktreeObservation,
} from './software-delivery-types.js';
import type { ActorRef } from './types.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ACTIVE_CONTENT = /(?:https?:\/\/|javascript:|data:text\/html|[<>])/i;
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:github_pat_|gh[opusr]_|sk-)[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{12,}|AWS_SECRET_ACCESS_KEY\s*=|OPENSLACK_[A-Z0-9_]*SECRET\s*=)/i;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const EVIDENCE_FIELDS = [
  'id',
  'authorityVersion',
  'observationKind',
  'observedAt',
  'sourceEventIds',
  'evidenceRefs',
] as const;

function fail(
  code: ConstructorParameters<typeof GraphContractError>[0],
  path: string,
  message: string,
): never {
  throw new GraphContractError(code, path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('GRAPH_SCHEMA_INVALID', path, 'must be an object.');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('GRAPH_SCHEMA_INVALID', `${path}.${key}`, 'is not an allowed property.');
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail('GRAPH_SCHEMA_INVALID', `${path}.${key}`, 'is required.');
    }
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function safeString(
  value: unknown,
  path: string,
  options: { max?: number; identifier?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.length === 0) {
    return fail('GRAPH_SCHEMA_INVALID', path, 'must be a non-empty string.');
  }
  const max = options.max ?? (options.identifier ? 512 : SOFTWARE_DELIVERY_SOURCE_LIMITS.textBytes);
  if (Buffer.byteLength(value, 'utf8') > max) {
    fail('GRAPH_BOUND_EXCEEDED', path, `must be at most ${max} UTF-8 bytes.`);
  }
  if (CONTROL_CHARACTER.test(value) || hasUnpairedSurrogate(value)) {
    fail('GRAPH_SCHEMA_INVALID', path, 'contains unsafe Unicode or control characters.');
  }
  if (ACTIVE_CONTENT.test(value) || SECRET_VALUE.test(value)) {
    fail('GRAPH_PROPERTY_UNSAFE', path, 'contains active content, a URL, or credential material.');
  }
  if (options.identifier && /\s/.test(value)) {
    fail('GRAPH_REFERENCE_INVALID', path, 'must be an identifier without whitespace.');
  }
  return value;
}

function dateTime(value: unknown, path: string): string {
  const result = safeString(value, path, { max: 64, identifier: true });
  const match = DATE_TIME.exec(result);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    !match ||
    month < 1 ||
    month > 12 ||
    days === undefined ||
    day < 1 ||
    day > days ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(result))
  ) {
    fail('GRAPH_SCHEMA_INVALID', path, 'must be a valid RFC 3339 date-time.');
  }
  return result;
}

function assertNotBefore(earlier: string, later: string, path: string): void {
  if (Date.parse(later) < Date.parse(earlier)) {
    fail('GRAPH_SCHEMA_INVALID', path, `must not precede ${earlier}.`);
  }
}

function boundedArray(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail('GRAPH_SCHEMA_INVALID', path, 'must be an array.');
  if (value.length > max) fail('GRAPH_BOUND_EXCEEDED', path, `must contain at most ${max} items.`);
  return value;
}

function references(value: unknown, path: string, max: number): string[] {
  const result = boundedArray(value, path, max).map((item, index) =>
    safeString(item, `${path}[${index}]`, { identifier: true }),
  );
  const seen = new Set<string>();
  result.forEach((item, index) => {
    if (seen.has(item)) {
      fail('GRAPH_REFERENCE_INVALID', `${path}[${index}]`, `duplicates reference ${item}.`);
    }
    seen.add(item);
  });
  return result;
}

function evidenceReferences(value: unknown, path: string): string[] {
  const result = boundedArray(value, path, 50).map((item, index) =>
    safeString(item, `${path}[${index}]`, { identifier: true, max: 2_048 }),
  );
  const seen = new Set<string>();
  result.forEach((item, index) => {
    if (seen.has(item)) {
      fail('GRAPH_REFERENCE_INVALID', `${path}[${index}]`, `duplicates reference ${item}.`);
    }
    seen.add(item);
  });
  return result;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail('GRAPH_SCHEMA_INVALID', path, `must be a safe integer >= ${minimum}.`);
  }
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('GRAPH_SCHEMA_INVALID', path, 'must be a boolean.');
  return value;
}

function enumeration<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail('GRAPH_SCHEMA_INVALID', path, `must be one of ${allowed.join(', ')}.`);
  }
  return value as T;
}

function observation(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): { object: Record<string, unknown>; evidence: SoftwareDeliveryEvidence } {
  const object = record(value, path);
  exactKeys(object, path, [...EVIDENCE_FIELDS, ...required], optional);
  return {
    object,
    evidence: {
      id: safeString(object.id, `${path}.id`, { identifier: true }),
      authorityVersion: safeString(object.authorityVersion, `${path}.authorityVersion`, {
        identifier: true,
      }),
      observationKind: source(object.observationKind, `${path}.observationKind`),
      observedAt: dateTime(object.observedAt, `${path}.observedAt`),
      sourceEventIds: evidenceReferences(object.sourceEventIds, `${path}.sourceEventIds`),
      evidenceRefs: evidenceReferences(object.evidenceRefs, `${path}.evidenceRefs`),
    },
  };
}

function actorRef(value: unknown, path: string): ActorRef {
  const object = record(value, path);
  exactKeys(object, path, ['id', 'kind'], ['displayName']);
  return {
    id: safeString(object.id, `${path}.id`, { identifier: true }),
    kind: enumeration(object.kind, `${path}.kind`, ['human', 'agent', 'system'] as const),
    ...(object.displayName === undefined
      ? {}
      : { displayName: safeString(object.displayName, `${path}.displayName`, { max: 512 }) }),
  };
}

function source(value: unknown, path: string): SoftwareDeliveryObservationSource {
  return enumeration(value, path, ['live', 'local_store', 'cache', 'synthetic'] as const);
}

function parseRepository(value: unknown, path: string): SoftwareDeliveryRepositoryObservation {
  const { object, evidence } = observation(value, path, [
    'repositoryId',
    'fullName',
    'defaultBranch',
  ]);
  return {
    ...evidence,
    repositoryId: safeString(object.repositoryId, `${path}.repositoryId`, { identifier: true }),
    fullName: safeString(object.fullName, `${path}.fullName`, { identifier: true }),
    defaultBranch: safeString(object.defaultBranch, `${path}.defaultBranch`, {
      identifier: true,
    }),
  };
}

function parseActor(value: unknown, path: string): SoftwareDeliveryActorObservation {
  const { object, evidence } = observation(value, path, ['authorityProvider', 'actor']);
  return {
    ...evidence,
    authorityProvider: enumeration(object.authorityProvider, `${path}.authorityProvider`, [
      'github',
      'openslack',
    ] as const),
    actor: actorRef(object.actor, `${path}.actor`),
  };
}

function parseLabel(value: unknown, path: string): SoftwareDeliveryLabel {
  const object = record(value, path);
  exactKeys(object, path, ['name', 'category']);
  return {
    name: safeString(object.name, `${path}.name`, { max: 256 }),
    category: enumeration(object.category, `${path}.category`, [
      'state',
      'risk',
      'capability',
      'other',
    ] as const),
  };
}

function parseIssue(value: unknown, path: string): SoftwareDeliveryIssueObservation {
  const { object, evidence } = observation(
    value,
    path,
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
    ['closedAt'],
  );
  const labels = boundedArray(
    object.labels,
    `${path}.labels`,
    SOFTWARE_DELIVERY_SOURCE_LIMITS.labelsPerIssue,
  ).map((item, index) => parseLabel(item, `${path}.labels[${index}]`));
  const labelIdentities = new Set<string>();
  labels.forEach((label, index) => {
    const identity = `${label.category}:${label.name}`;
    if (labelIdentities.has(identity)) {
      fail(
        'GRAPH_REFERENCE_INVALID',
        `${path}.labels[${index}]`,
        `duplicates label identity ${identity}.`,
      );
    }
    labelIdentities.add(identity);
  });
  const assigneeIds = references(object.assigneeIds, `${path}.assigneeIds`, 50);
  const state = enumeration(object.state, `${path}.state`, ['open', 'closed'] as const);
  const closureComplete = boolean(object.closureComplete, `${path}.closureComplete`);
  const closedAt =
    object.closedAt === undefined ? undefined : dateTime(object.closedAt, `${path}.closedAt`);
  const createdAt = dateTime(object.createdAt, `${path}.createdAt`);
  const updatedAt = dateTime(object.updatedAt, `${path}.updatedAt`);
  assertNotBefore(createdAt, updatedAt, `${path}.updatedAt`);
  if (closedAt !== undefined) assertNotBefore(createdAt, closedAt, `${path}.closedAt`);
  if (closureComplete && state === 'closed' && closedAt === undefined) {
    fail(
      'GRAPH_SCHEMA_INVALID',
      `${path}.closedAt`,
      'is required for a closure-complete closed issue.',
    );
  }
  if (state === 'open' && closedAt !== undefined) {
    fail('GRAPH_SCHEMA_INVALID', `${path}.closedAt`, 'is not valid for an open issue.');
  }
  return {
    ...evidence,
    repositoryId: safeString(object.repositoryId, `${path}.repositoryId`, { identifier: true }),
    number: integer(object.number, `${path}.number`, 1),
    title: safeString(object.title, `${path}.title`),
    state,
    labels,
    assigneeIds,
    assigneesComplete: boolean(object.assigneesComplete, `${path}.assigneesComplete`),
    closureComplete,
    createdAt,
    updatedAt,
    ...(closedAt === undefined ? {} : { closedAt }),
  };
}

function parseClaim(value: unknown, path: string): SoftwareDeliveryClaimObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['issueId', 'claimRef', 'status', 'agentActorId', 'claimedAt', 'expiresAt'],
    ['targetSha'],
  );
  const claimedAt = dateTime(object.claimedAt, `${path}.claimedAt`);
  const expiresAt = dateTime(object.expiresAt, `${path}.expiresAt`);
  assertNotBefore(claimedAt, expiresAt, `${path}.expiresAt`);
  return {
    ...evidence,
    issueId: safeString(object.issueId, `${path}.issueId`, { identifier: true }),
    claimRef: safeString(object.claimRef, `${path}.claimRef`, { identifier: true }),
    ...(object.targetSha === undefined
      ? {}
      : { targetSha: safeString(object.targetSha, `${path}.targetSha`, { identifier: true }) }),
    status: enumeration(object.status, `${path}.status`, [
      'active',
      'expired',
      'released',
    ] as const),
    agentActorId: safeString(object.agentActorId, `${path}.agentActorId`, { identifier: true }),
    claimedAt,
    expiresAt,
  };
}

function parseWorktree(value: unknown, path: string): SoftwareDeliveryWorktreeObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['issueId', 'worktreeId', 'branchName', 'status', 'createdAt'],
    ['claimId', 'agentRunId', 'baseSha', 'closedAt'],
  );
  const status = enumeration(object.status, `${path}.status`, [
    'active',
    'preserved',
    'cleaned',
  ] as const);
  const createdAt = dateTime(object.createdAt, `${path}.createdAt`);
  const closedAt =
    object.closedAt === undefined ? undefined : dateTime(object.closedAt, `${path}.closedAt`);
  if (closedAt !== undefined) assertNotBefore(createdAt, closedAt, `${path}.closedAt`);
  if (status === 'cleaned' && closedAt === undefined) {
    fail('GRAPH_SCHEMA_INVALID', `${path}.closedAt`, 'is required for a cleaned worktree.');
  }
  if (status === 'active' && closedAt !== undefined) {
    fail('GRAPH_SCHEMA_INVALID', `${path}.closedAt`, 'is not valid for an active worktree.');
  }
  return {
    ...evidence,
    issueId: safeString(object.issueId, `${path}.issueId`, { identifier: true }),
    ...(object.claimId === undefined
      ? {}
      : { claimId: safeString(object.claimId, `${path}.claimId`, { identifier: true }) }),
    ...(object.agentRunId === undefined
      ? {}
      : { agentRunId: safeString(object.agentRunId, `${path}.agentRunId`, { identifier: true }) }),
    worktreeId: safeString(object.worktreeId, `${path}.worktreeId`, { identifier: true }),
    ...(object.baseSha === undefined
      ? {}
      : { baseSha: safeString(object.baseSha, `${path}.baseSha`, { identifier: true }) }),
    branchName: safeString(object.branchName, `${path}.branchName`, { identifier: true }),
    status,
    createdAt,
    ...(closedAt === undefined ? {} : { closedAt }),
  };
}

function parseCommit(value: unknown, path: string): SoftwareDeliveryCommitObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['repositoryId', 'sha', 'issueIds', 'authoredAt'],
    ['worktreeId'],
  );
  return {
    ...evidence,
    repositoryId: safeString(object.repositoryId, `${path}.repositoryId`, { identifier: true }),
    sha: safeString(object.sha, `${path}.sha`, { identifier: true }),
    issueIds: references(
      object.issueIds,
      `${path}.issueIds`,
      SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation,
    ),
    ...(object.worktreeId === undefined
      ? {}
      : { worktreeId: safeString(object.worktreeId, `${path}.worktreeId`, { identifier: true }) }),
    authoredAt: dateTime(object.authoredAt, `${path}.authoredAt`),
  };
}

function parsePullRequest(value: unknown, path: string): SoftwareDeliveryPullRequestObservation {
  const { object, evidence } = observation(
    value,
    path,
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
    ['baseSha', 'headSha'],
  );
  const openedAt = dateTime(object.openedAt, `${path}.openedAt`);
  const updatedAt = dateTime(object.updatedAt, `${path}.updatedAt`);
  assertNotBefore(openedAt, updatedAt, `${path}.updatedAt`);
  return {
    ...evidence,
    repositoryId: safeString(object.repositoryId, `${path}.repositoryId`, { identifier: true }),
    number: integer(object.number, `${path}.number`, 1),
    title: safeString(object.title, `${path}.title`),
    authorActorId: safeString(object.authorActorId, `${path}.authorActorId`, {
      identifier: true,
    }),
    state: enumeration(object.state, `${path}.state`, ['open', 'closed', 'merged'] as const),
    draft: boolean(object.draft, `${path}.draft`),
    ...(object.baseSha === undefined
      ? {}
      : { baseSha: safeString(object.baseSha, `${path}.baseSha`, { identifier: true }) }),
    ...(object.headSha === undefined
      ? {}
      : { headSha: safeString(object.headSha, `${path}.headSha`, { identifier: true }) }),
    issueIds: references(
      object.issueIds,
      `${path}.issueIds`,
      SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation,
    ),
    commitShas: references(
      object.commitShas,
      `${path}.commitShas`,
      SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation,
    ),
    openedAt,
    updatedAt,
  };
}

function parseCheck(value: unknown, path: string): SoftwareDeliveryCheckObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['pullRequestId', 'name', 'status', 'startedAt'],
    ['conclusion', 'headSha', 'completedAt'],
  );
  const status = enumeration(object.status, `${path}.status`, [
    'queued',
    'in_progress',
    'completed',
  ] as const);
  const conclusion =
    object.conclusion === undefined
      ? undefined
      : enumeration(object.conclusion, `${path}.conclusion`, [
          'success',
          'failure',
          'neutral',
          'cancelled',
          'skipped',
          'timed_out',
          'action_required',
          'stale',
          'startup_failure',
        ] as const);
  const startedAt = dateTime(object.startedAt, `${path}.startedAt`);
  const completedAt =
    object.completedAt === undefined
      ? undefined
      : dateTime(object.completedAt, `${path}.completedAt`);
  if (completedAt !== undefined) assertNotBefore(startedAt, completedAt, `${path}.completedAt`);
  if (status === 'completed' && (completedAt === undefined || conclusion === undefined)) {
    fail('GRAPH_SCHEMA_INVALID', path, 'a completed check requires completedAt and conclusion.');
  }
  if (status !== 'completed' && (completedAt !== undefined || conclusion !== undefined)) {
    fail(
      'GRAPH_SCHEMA_INVALID',
      path,
      'a non-completed check cannot carry completedAt or conclusion.',
    );
  }
  return {
    ...evidence,
    pullRequestId: safeString(object.pullRequestId, `${path}.pullRequestId`, {
      identifier: true,
    }),
    name: safeString(object.name, `${path}.name`, { max: 512 }),
    status,
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(object.headSha === undefined
      ? {}
      : { headSha: safeString(object.headSha, `${path}.headSha`, { identifier: true }) }),
    startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function parseReview(value: unknown, path: string): SoftwareDeliveryReviewObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['pullRequestId', 'actorId', 'actorKind', 'state', 'submittedAt'],
    ['commitOid'],
  );
  return {
    ...evidence,
    pullRequestId: safeString(object.pullRequestId, `${path}.pullRequestId`, {
      identifier: true,
    }),
    actorId: safeString(object.actorId, `${path}.actorId`, { identifier: true }),
    actorKind: enumeration(object.actorKind, `${path}.actorKind`, [
      'human',
      'agent',
      'system',
    ] as const),
    state: enumeration(object.state, `${path}.state`, [
      'APPROVED',
      'CHANGES_REQUESTED',
      'COMMENTED',
      'DISMISSED',
    ] as const),
    ...(object.commitOid === undefined
      ? {}
      : { commitOid: safeString(object.commitOid, `${path}.commitOid`, { identifier: true }) }),
    submittedAt: dateTime(object.submittedAt, `${path}.submittedAt`),
  };
}

function parseMerge(value: unknown, path: string): SoftwareDeliveryMergeObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['pullRequestId', 'actorId', 'mergedAt'],
    ['headSha', 'mergeCommitSha'],
  );
  return {
    ...evidence,
    pullRequestId: safeString(object.pullRequestId, `${path}.pullRequestId`, {
      identifier: true,
    }),
    ...(object.headSha === undefined
      ? {}
      : { headSha: safeString(object.headSha, `${path}.headSha`, { identifier: true }) }),
    ...(object.mergeCommitSha === undefined
      ? {}
      : {
          mergeCommitSha: safeString(object.mergeCommitSha, `${path}.mergeCommitSha`, {
            identifier: true,
          }),
        }),
    actorId: safeString(object.actorId, `${path}.actorId`, { identifier: true }),
    mergedAt: dateTime(object.mergedAt, `${path}.mergedAt`),
  };
}

function parseWorkflow(value: unknown, path: string): SoftwareDeliveryWorkflowRunObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['workflowId', 'status', 'issueIds', 'pullRequestIds', 'startedAt'],
    ['completedAt'],
  );
  const status = enumeration(object.status, `${path}.status`, [
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
  ] as const);
  const startedAt = dateTime(object.startedAt, `${path}.startedAt`);
  const completedAt =
    object.completedAt === undefined
      ? undefined
      : dateTime(object.completedAt, `${path}.completedAt`);
  if (completedAt !== undefined) assertNotBefore(startedAt, completedAt, `${path}.completedAt`);
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  if (terminal !== (completedAt !== undefined)) {
    fail(
      'GRAPH_SCHEMA_INVALID',
      `${path}.completedAt`,
      terminal ? `is required for ${status}.` : `is not valid for ${status}.`,
    );
  }
  return {
    ...evidence,
    workflowId: safeString(object.workflowId, `${path}.workflowId`, { identifier: true }),
    status,
    issueIds: references(
      object.issueIds,
      `${path}.issueIds`,
      SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation,
    ),
    pullRequestIds: references(
      object.pullRequestIds,
      `${path}.pullRequestIds`,
      SOFTWARE_DELIVERY_SOURCE_LIMITS.relationsPerObservation,
    ),
    startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function parseAgentRun(value: unknown, path: string): SoftwareDeliveryAgentRunObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['agentActorId', 'status', 'startedAt'],
    ['workflowRunId', 'worktreeId', 'completedAt'],
  );
  const status = enumeration(object.status, `${path}.status`, [
    'pending',
    'running',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ] as const);
  const startedAt = dateTime(object.startedAt, `${path}.startedAt`);
  const completedAt =
    object.completedAt === undefined
      ? undefined
      : dateTime(object.completedAt, `${path}.completedAt`);
  if (completedAt !== undefined) assertNotBefore(startedAt, completedAt, `${path}.completedAt`);
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  if (terminal !== (completedAt !== undefined)) {
    fail(
      'GRAPH_SCHEMA_INVALID',
      `${path}.completedAt`,
      terminal ? `is required for ${status}.` : `is not valid for ${status}.`,
    );
  }
  return {
    ...evidence,
    ...(object.workflowRunId === undefined
      ? {}
      : {
          workflowRunId: safeString(object.workflowRunId, `${path}.workflowRunId`, {
            identifier: true,
          }),
        }),
    agentActorId: safeString(object.agentActorId, `${path}.agentActorId`, { identifier: true }),
    status,
    ...(object.worktreeId === undefined
      ? {}
      : { worktreeId: safeString(object.worktreeId, `${path}.worktreeId`, { identifier: true }) }),
    startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function parsePrms(value: unknown, path: string): SoftwareDeliveryPrmsReportObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['pullRequestId', 'status', 'blockerCount'],
    ['baseSha', 'headSha'],
  );
  const status = enumeration(object.status, `${path}.status`, [
    'ready',
    'blocked',
    'needs_human_approval',
    'failed',
  ] as const);
  const blockerCount = integer(object.blockerCount, `${path}.blockerCount`);
  if (status === 'ready' && blockerCount !== 0) {
    fail('GRAPH_SCHEMA_INVALID', path, 'a ready PRMS report must have blockerCount 0.');
  }
  return {
    ...evidence,
    pullRequestId: safeString(object.pullRequestId, `${path}.pullRequestId`, {
      identifier: true,
    }),
    ...(object.baseSha === undefined
      ? {}
      : { baseSha: safeString(object.baseSha, `${path}.baseSha`, { identifier: true }) }),
    ...(object.headSha === undefined
      ? {}
      : { headSha: safeString(object.headSha, `${path}.headSha`, { identifier: true }) }),
    status,
    blockerCount,
  };
}

function parseHandoff(value: unknown, path: string): SoftwareDeliveryHandoffObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['status', 'fromActorId', 'toActorId', 'createdAt'],
    ['issueId', 'pullRequestId', 'workflowRunId', 'closedAt'],
  );
  const status = enumeration(object.status, `${path}.status`, [
    'open',
    'accepted',
    'closed',
  ] as const);
  const createdAt = dateTime(object.createdAt, `${path}.createdAt`);
  const closedAt =
    object.closedAt === undefined ? undefined : dateTime(object.closedAt, `${path}.closedAt`);
  if (closedAt !== undefined) assertNotBefore(createdAt, closedAt, `${path}.closedAt`);
  if ((status === 'closed') !== (closedAt !== undefined)) {
    fail(
      'GRAPH_SCHEMA_INVALID',
      `${path}.closedAt`,
      status === 'closed' ? 'is required for a closed handoff.' : `is not valid for ${status}.`,
    );
  }
  return {
    ...evidence,
    status,
    fromActorId: safeString(object.fromActorId, `${path}.fromActorId`, { identifier: true }),
    toActorId: safeString(object.toActorId, `${path}.toActorId`, { identifier: true }),
    ...(object.issueId === undefined
      ? {}
      : { issueId: safeString(object.issueId, `${path}.issueId`, { identifier: true }) }),
    ...(object.pullRequestId === undefined
      ? {}
      : {
          pullRequestId: safeString(object.pullRequestId, `${path}.pullRequestId`, {
            identifier: true,
          }),
        }),
    ...(object.workflowRunId === undefined
      ? {}
      : {
          workflowRunId: safeString(object.workflowRunId, `${path}.workflowRunId`, {
            identifier: true,
          }),
        }),
    createdAt,
    ...(closedAt === undefined ? {} : { closedAt }),
  };
}

function parseDecision(value: unknown, path: string): SoftwareDeliveryDecisionObservation {
  const { object, evidence } = observation(
    value,
    path,
    ['topic', 'status', 'decidedByActorId', 'createdAt'],
    ['issueId', 'pullRequestId', 'workflowRunId', 'supersededAt'],
  );
  const status = enumeration(object.status, `${path}.status`, ['active', 'superseded'] as const);
  const createdAt = dateTime(object.createdAt, `${path}.createdAt`);
  const supersededAt =
    object.supersededAt === undefined
      ? undefined
      : dateTime(object.supersededAt, `${path}.supersededAt`);
  if (supersededAt !== undefined) {
    assertNotBefore(createdAt, supersededAt, `${path}.supersededAt`);
  }
  if ((status === 'superseded') !== (supersededAt !== undefined)) {
    fail(
      'GRAPH_SCHEMA_INVALID',
      `${path}.supersededAt`,
      status === 'superseded'
        ? 'is required for a superseded decision.'
        : 'is not valid for an active decision.',
    );
  }
  return {
    ...evidence,
    topic: safeString(object.topic, `${path}.topic`),
    status,
    decidedByActorId: safeString(object.decidedByActorId, `${path}.decidedByActorId`, {
      identifier: true,
    }),
    ...(object.issueId === undefined
      ? {}
      : { issueId: safeString(object.issueId, `${path}.issueId`, { identifier: true }) }),
    ...(object.pullRequestId === undefined
      ? {}
      : {
          pullRequestId: safeString(object.pullRequestId, `${path}.pullRequestId`, {
            identifier: true,
          }),
        }),
    ...(object.workflowRunId === undefined
      ? {}
      : {
          workflowRunId: safeString(object.workflowRunId, `${path}.workflowRunId`, {
            identifier: true,
          }),
        }),
    createdAt,
    ...(supersededAt === undefined ? {} : { supersededAt }),
  };
}

function collection<T extends SoftwareDeliveryEvidence>(
  value: unknown,
  path: string,
  parser: (item: unknown, path: string) => T,
  identity: (item: T) => string,
): T[] {
  const items = boundedArray(value, path, SOFTWARE_DELIVERY_SOURCE_LIMITS.observationsPerKind).map(
    (item, index) => parser(item, `${path}[${index}]`),
  );
  const seen = new Set<string>();
  const evidenceIds = new Set<string>();
  items.forEach((item, index) => {
    if (evidenceIds.has(item.id)) {
      fail(
        'GRAPH_REFERENCE_INVALID',
        `${path}[${index}].id`,
        `duplicates observation identity ${item.id}.`,
      );
    }
    evidenceIds.add(item.id);
    const id = identity(item);
    if (seen.has(id)) {
      fail('GRAPH_REFERENCE_INVALID', `${path}[${index}]`, `duplicates source identity ${id}.`);
    }
    seen.add(id);
  });
  return items;
}

function batch<T extends SoftwareDeliveryEvidence>(
  value: unknown,
  path: string,
  parser: (item: unknown, path: string) => T,
  identity: (item: T) => string,
  maxItems: number = SOFTWARE_DELIVERY_SOURCE_LIMITS.observationsPerKind,
): SoftwareDeliverySourceBatch<T> {
  const object = record(value, path);
  const status = enumeration(object.status, `${path}.status`, [
    'observed',
    'incomplete',
    'missing',
  ] as const);
  if (status === 'missing') {
    exactKeys(object, path, ['status', 'items', 'reasonCode']);
    const items = boundedArray(object.items, `${path}.items`, 0);
    if (items.length !== 0) {
      fail('GRAPH_SCHEMA_INVALID', `${path}.items`, 'must be empty for a missing batch.');
    }
    return {
      status,
      items: [],
      reasonCode: safeString(object.reasonCode, `${path}.reasonCode`, { identifier: true }),
    };
  }

  exactKeys(object, path, ['status', 'items', 'warningCodes'], ['batchVersion', 'observedAt']);
  const items = collection(object.items, `${path}.items`, parser, identity);
  if (items.length > maxItems) {
    fail('GRAPH_BOUND_EXCEEDED', `${path}.items`, `must contain at most ${maxItems} items.`);
  }
  const warningCodes = references(
    object.warningCodes,
    `${path}.warningCodes`,
    SOFTWARE_DELIVERY_SOURCE_LIMITS.completenessEntries,
  );
  if (status === 'observed') {
    if (object.batchVersion === undefined || object.observedAt === undefined) {
      fail('GRAPH_SCHEMA_INVALID', path, 'an observed batch requires batchVersion and observedAt.');
    }
    return {
      status,
      batchVersion: safeString(object.batchVersion, `${path}.batchVersion`, {
        identifier: true,
      }),
      observedAt: dateTime(object.observedAt, `${path}.observedAt`),
      items,
      warningCodes,
    };
  }

  if (warningCodes.length === 0) {
    fail('GRAPH_SCHEMA_INVALID', `${path}.warningCodes`, 'must explain an incomplete batch.');
  }
  if ((object.batchVersion === undefined) !== (object.observedAt === undefined)) {
    fail(
      'GRAPH_SCHEMA_INVALID',
      path,
      'incomplete batchVersion and observedAt must either both be present or both be absent.',
    );
  }
  return {
    status,
    ...(object.batchVersion === undefined
      ? {}
      : {
          batchVersion: safeString(object.batchVersion, `${path}.batchVersion`, {
            identifier: true,
          }),
          observedAt: dateTime(object.observedAt, `${path}.observedAt`),
        }),
    items,
    warningCodes,
  };
}

function assertAggregateBounds(sources: SoftwareDeliverySourceBatches): void {
  const batches = Object.values(sources);
  const totalObservations = batches.reduce((total, candidate) => total + candidate.items.length, 0);
  if (totalObservations > SOFTWARE_DELIVERY_SOURCE_LIMITS.totalObservations) {
    fail(
      'GRAPH_BOUND_EXCEEDED',
      '$.sources',
      `contains ${totalObservations} observations; maximum is ${SOFTWARE_DELIVERY_SOURCE_LIMITS.totalObservations}.`,
    );
  }
  const totalRelations =
    sources.issues.items.reduce(
      (total, item) => total + 1 + item.assigneeIds.length + Number(item.state === 'closed'),
      0,
    ) +
    sources.claims.items.length * 2 +
    sources.worktrees.items.reduce(
      (total, item) =>
        total + 1 + Number(item.claimId !== undefined) + Number(item.agentRunId !== undefined),
      0,
    ) +
    sources.commits.items.reduce(
      (total, item) => total + item.issueIds.length + (item.worktreeId ? 1 : 0),
      0,
    ) +
    sources.pullRequests.items.reduce(
      (total, item) => total + item.issueIds.length + item.commitShas.length,
      0,
    ) +
    sources.workflowRuns.items.reduce(
      (total, item) => total + item.issueIds.length + item.pullRequestIds.length,
      0,
    ) +
    sources.checks.items.length +
    sources.reviews.items.length +
    sources.merges.items.length +
    sources.prmsReports.items.length +
    sources.agentRuns.items.reduce(
      (total, item) =>
        total +
        1 +
        Number(item.workflowRunId !== undefined) +
        Number(item.worktreeId !== undefined),
      0,
    ) +
    sources.handoffs.items.reduce(
      (total, item) =>
        total +
        2 +
        Number(item.issueId !== undefined) +
        Number(item.pullRequestId !== undefined) +
        Number(item.workflowRunId !== undefined),
      0,
    ) +
    sources.decisions.items.reduce(
      (total, item) =>
        total +
        Number(item.issueId !== undefined) +
        Number(item.pullRequestId !== undefined) +
        Number(item.workflowRunId !== undefined),
      0,
    );
  if (totalRelations > SOFTWARE_DELIVERY_SOURCE_LIMITS.totalRelations) {
    fail(
      'GRAPH_BOUND_EXCEEDED',
      '$.sources',
      `contains ${totalRelations} relations; maximum is ${SOFTWARE_DELIVERY_SOURCE_LIMITS.totalRelations}.`,
    );
  }
}

function assertSemanticUnique<T>(
  items: readonly T[],
  path: string,
  identity: (item: T) => string,
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const value = identity(item);
    if (seen.has(value)) {
      fail(
        'GRAPH_REFERENCE_INVALID',
        `${path}[${index}]`,
        `duplicates semantic authority identity ${value}.`,
      );
    }
    seen.add(value);
  });
}

export function validateSoftwareDeliverySourceSnapshot(
  value: unknown,
): SoftwareDeliverySourceSnapshot {
  const bytes = inertGraphJsonBytes(value, SOFTWARE_DELIVERY_SOURCE_LIMITS);
  if (bytes > SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes) {
    fail(
      'GRAPH_BOUND_EXCEEDED',
      '$',
      `contains ${bytes} bytes; maximum is ${SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes}.`,
    );
  }
  const object = record(value, '$');
  const sourceNames = [
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
  ] as const;
  exactKeys(object, '$', [
    'schema',
    'scenarioDefinitionId',
    'scenarioInstanceId',
    'cursor',
    'generatedAt',
    'projectorVersion',
    'sources',
  ]);
  if (object.schema !== SOFTWARE_DELIVERY_SOURCE_SCHEMA) {
    fail('GRAPH_SCHEMA_INVALID', '$.schema', `must equal ${SOFTWARE_DELIVERY_SOURCE_SCHEMA}.`);
  }

  const sourceObject = record(object.sources, '$.sources');
  exactKeys(sourceObject, '$.sources', sourceNames);
  const sources: SoftwareDeliverySourceBatches = {
    repository: batch(
      sourceObject.repository,
      '$.sources.repository',
      parseRepository,
      (item) => item.repositoryId,
      1,
    ),
    actors: batch(sourceObject.actors, '$.sources.actors', parseActor, (item) => item.actor.id),
    issues: batch(sourceObject.issues, '$.sources.issues', parseIssue, (item) => item.id),
    claims: batch(sourceObject.claims, '$.sources.claims', parseClaim, (item) => item.claimRef),
    worktrees: batch(
      sourceObject.worktrees,
      '$.sources.worktrees',
      parseWorktree,
      (item) => item.worktreeId,
    ),
    commits: batch(sourceObject.commits, '$.sources.commits', parseCommit, (item) => item.sha),
    pullRequests: batch(
      sourceObject.pullRequests,
      '$.sources.pullRequests',
      parsePullRequest,
      (item) => item.id,
    ),
    checks: batch(sourceObject.checks, '$.sources.checks', parseCheck, (item) => item.id),
    reviews: batch(sourceObject.reviews, '$.sources.reviews', parseReview, (item) => item.id),
    merges: batch(sourceObject.merges, '$.sources.merges', parseMerge, (item) => item.id),
    workflowRuns: batch(
      sourceObject.workflowRuns,
      '$.sources.workflowRuns',
      parseWorkflow,
      (item) => item.id,
    ),
    agentRuns: batch(
      sourceObject.agentRuns,
      '$.sources.agentRuns',
      parseAgentRun,
      (item) => item.id,
    ),
    prmsReports: batch(
      sourceObject.prmsReports,
      '$.sources.prmsReports',
      parsePrms,
      (item) => item.id,
    ),
    handoffs: batch(sourceObject.handoffs, '$.sources.handoffs', parseHandoff, (item) => item.id),
    decisions: batch(
      sourceObject.decisions,
      '$.sources.decisions',
      parseDecision,
      (item) => item.id,
    ),
  };

  const actors = sources.actors.items;
  const actorEvidenceIds = new Set<string>();
  actors.forEach((item, index) => {
    if (actorEvidenceIds.has(item.id)) {
      fail(
        'GRAPH_REFERENCE_INVALID',
        `$.actors[${index}].id`,
        `duplicates observation identity ${item.id}.`,
      );
    }
    actorEvidenceIds.add(item.id);
  });

  const pullRequests = sources.pullRequests.items;
  const prNumbers = new Set<string>();
  pullRequests.forEach((item, index) => {
    const numberIdentity = `${item.repositoryId}#${item.number}`;
    if (prNumbers.has(numberIdentity)) {
      fail(
        'GRAPH_REFERENCE_INVALID',
        `$.pullRequests[${index}].number`,
        `duplicates pull request identity ${numberIdentity}.`,
      );
    }
    prNumbers.add(numberIdentity);
  });
  assertSemanticUnique(
    sources.issues.items,
    '$.sources.issues.items',
    (item) => `${item.repositoryId}#${item.number}`,
  );
  assertSemanticUnique(
    sources.merges.items,
    '$.sources.merges.items',
    (item) => `${item.pullRequestId}:${item.headSha ?? 'missing-head'}`,
  );
  assertSemanticUnique(
    sources.prmsReports.items,
    '$.sources.prmsReports.items',
    (item) =>
      `${item.pullRequestId}:${item.baseSha ?? 'missing-base'}:${item.headSha ?? 'missing-head'}`,
  );
  assertSemanticUnique(
    sources.reviews.items,
    '$.sources.reviews.items',
    (item) =>
      `${item.pullRequestId}:${item.actorId}:${item.commitOid ?? 'missing-head'}:${Date.parse(item.submittedAt)}`,
  );
  assertAggregateBounds(sources);
  const projectorVersion = safeString(object.projectorVersion, '$.projectorVersion', {
    identifier: true,
  });
  if (projectorVersion !== SOFTWARE_DELIVERY_PROJECTOR_ID) {
    fail(
      'GRAPH_SCHEMA_INVALID',
      '$.projectorVersion',
      `must equal the registered projector ${SOFTWARE_DELIVERY_PROJECTOR_ID}.`,
    );
  }

  return {
    schema: SOFTWARE_DELIVERY_SOURCE_SCHEMA,
    scenarioDefinitionId: safeString(object.scenarioDefinitionId, '$.scenarioDefinitionId', {
      identifier: true,
    }),
    scenarioInstanceId: safeString(object.scenarioInstanceId, '$.scenarioInstanceId', {
      identifier: true,
    }),
    cursor: safeString(object.cursor, '$.cursor', { identifier: true }),
    generatedAt: dateTime(object.generatedAt, '$.generatedAt'),
    projectorVersion,
    sources,
  };
}
